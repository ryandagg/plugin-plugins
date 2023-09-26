import {exec as cpExec} from 'node:child_process'
import {mkdir} from 'node:fs/promises'
import {join, resolve} from 'node:path'

import {expect} from 'chai'
import {dim} from 'chalk'

async function exec(command: string): Promise<{stdout: string, stderr: string, code: number}> {
  return new Promise((resolve, reject) => {
    cpExec(command, (error, stdout, stderr) => {
      if (error) {
        reject(error)
      } else {
        resolve({stdout, stderr, code: 0})
      }
    })
  })
}

async function ensureSfExists(): Promise<boolean> {
  try {
    const {stdout} = await exec('sf --version')
    console.log('sf version:', dim(stdout.trim()))
    return true
  } catch {
    return false
  }
}

describe('sf Integration', () => {
  before(async () => {
    await ensureSfExists()

    const tmp = resolve('tmp')
    process.env.SF_DATA_DIR = join(tmp, 'data')
    process.env.SF_CACHE_DIR = join(tmp, 'cache')
    process.env.SF_CONFIG_DIR = join(tmp, 'config')
    mkdir(process.env.SF_DATA_DIR, {recursive: true})
    mkdir(process.env.SF_CACHE_DIR, {recursive: true})
    mkdir(process.env.SF_CONFIG_DIR, {recursive: true})

    console.log('process.env.SF_DATA_DIR:', dim(process.env.SF_DATA_DIR))
    console.log('process.env.SF_CACHE_DIR:', dim(process.env.SF_CACHE_DIR))
    console.log('process.env.SF_CONFIG_DIR:', dim(process.env.SF_CONFIG_DIR))

    await exec('sf plugins link')
    const {stdout} = await exec('sf plugins --core')
    expect(stdout).to.contain('@oclif/plugin-plugins')
    expect(stdout).to.contain(`(link) ${process.cwd()}`)
  })

  it('should install plugin with oclif.lock', async () => {
    const result = await exec('sf plugins install custom-metadata@2.2.1')
    expect(result.code).to.equal(0)

    const inspectResult = await exec('sf plugins inspect custom-metadata --json')
    const [plugin] = JSON.parse(inspectResult.stdout)

    const expected = {
      '@oclif/core': {from: '^2.15.0', version: '2.15.0'},
      '@salesforce/core': {from: '^5.2.0', version: '5.2.6'},
      '@salesforce/sf-plugins-core': {from: '^3.1.20', version: '3.1.21'},
      '@salesforce/ts-types': {from: '^2.0.6', version: '2.0.7'},
      'csv-parse': {from: '^5.4.0', version: '5.4.0'},
      'fast-xml-parser': {from: '^4.2.7', version: '4.2.7'},
      tslib: {from: '^2', version: '2.6.2'},
    }

    expect(plugin.deps).to.deep.equal(expected)
  })

  it('should keep locked deps despite other plugin installs', async () => {
    const result = await exec('sf plugins install settings')
    expect(result.code).to.equal(0)

    const inspectResult = await exec('sf plugins inspect custom-metadata --json')
    const [plugin] = JSON.parse(inspectResult.stdout)

    const expected = {
      '@oclif/core': {from: '^2.15.0', version: '2.15.0'},
      '@salesforce/core': {from: '^5.2.0', version: '5.2.6'},
      '@salesforce/sf-plugins-core': {from: '^3.1.20', version: '3.1.21'},
      '@salesforce/ts-types': {from: '^2.0.6', version: '2.0.7'},
      'csv-parse': {from: '^5.4.0', version: '5.4.0'},
      'fast-xml-parser': {from: '^4.2.7', version: '4.2.7'},
      tslib: {from: '^2', version: '2.6.2'},
    }

    expect(plugin.deps).to.deep.equal(expected)
  })
})