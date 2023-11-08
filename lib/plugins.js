import { Config, Errors, ux } from '@oclif/core';
import makeDebug from 'debug';
import { access, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { gt, valid, validRange } from 'semver';
import { findNode, findNpm, uniq, uniqWith } from './util.js';
import Yarn from './yarn.js';
const initPJSON = {
    dependencies: {},
    oclif: { plugins: [], schema: 1 },
    private: true,
};
async function fileExists(filePath) {
    try {
        await access(filePath);
        return true;
    }
    catch {
        return false;
    }
}
export default class Plugins {
    config;
    silent = false;
    verbose = false;
    yarn;
    debug;
    constructor(config) {
        this.config = config;
        this.yarn = new Yarn({ config });
        this.debug = makeDebug('@oclif/plugins');
    }
    async add(...plugins) {
        const pjson = await this.pjson();
        await this.savePJSON({
            ...pjson,
            oclif: {
                ...pjson.oclif,
                plugins: uniq([...(pjson.oclif.plugins || []), ...plugins]),
            },
        });
    }
    friendlyName(name) {
        const { pluginPrefix, scope } = this.config.pjson.oclif;
        if (!scope)
            return name;
        const match = name.match(`@${scope}/${pluginPrefix ?? 'plugin'}-(.+)`);
        return match?.[1] ?? name;
    }
    async hasPlugin(name) {
        const list = await this.list();
        return (list.find((p) => this.friendlyName(p.name) === this.friendlyName(name)) ?? // friendly
            list.find((p) => this.unfriendlyName(p.name) === this.unfriendlyName(name)) ?? // unfriendly
            list.find((p) => p.type === 'link' && resolve(p.root) === resolve(name)) ?? // link
            false);
    }
    async install(name, { force = false, tag = 'latest' } = {}) {
        try {
            this.debug(`installing plugin ${name}`);
            const yarnOpts = { cwd: this.config.dataDir, silent: this.silent, verbose: this.verbose };
            await this.createPJSON();
            let plugin;
            const add = force ? ['add', '--force'] : ['add'];
            if (name.includes(':')) {
                // url
                const url = name;
                await this.yarn.exec([...add, url], yarnOpts);
                const { dependencies } = await this.pjson();
                name = Object.entries(dependencies ?? {}).find(([, u]) => u === url)[0];
                const root = join(this.config.dataDir, 'node_modules', name);
                plugin = await Config.load({
                    devPlugins: false,
                    name,
                    root,
                    userPlugins: false,
                });
                await this.refresh({ all: true, prod: true }, plugin.root);
                this.isValidPlugin(plugin);
                await this.add({ name, type: 'user', url });
                if (plugin.getPluginsList().find((p) => p.root === root)?.moduleType === 'module' &&
                    (await fileExists(join(plugin.root, 'tsconfig.json')))) {
                    try {
                        // CJS plugins can be auto-transpiled at runtime but ESM plugins
                        // cannot. To support ESM plugins we need to compile them after
                        // installing them.
                        await this.yarn.exec(['run', 'tsc'], { ...yarnOpts, cwd: plugin.root });
                    }
                    catch (error) {
                        this.debug(error);
                    }
                }
            }
            else {
                // npm
                const range = validRange(tag);
                const unfriendly = this.unfriendlyName(name);
                if (unfriendly && (await this.npmHasPackage(unfriendly))) {
                    name = unfriendly;
                }
                // validate that the package name exists in the npm registry before installing
                await this.npmHasPackage(name, true);
                await this.yarn.exec([...add, `${name}@${tag}`], yarnOpts);
                this.debug(`loading plugin ${name}...`);
                plugin = await Config.load({
                    devPlugins: false,
                    name,
                    root: join(this.config.dataDir, 'node_modules', name),
                    userPlugins: false,
                });
                this.debug(`finished loading plugin ${name} at root ${plugin.root}`);
                this.isValidPlugin(plugin);
                await this.refresh({ all: true, prod: true }, plugin.root);
                await this.add({ name, tag: range || tag, type: 'user' });
            }
            return plugin;
        }
        catch (error) {
            this.debug('error installing plugin:', error);
            await this.uninstall(name).catch((error) => this.debug(error));
            if (String(error).includes('EACCES')) {
                throw new Errors.CLIError(error, {
                    suggestions: [
                        `Plugin failed to install because of a permissions error.\nDoes your current user own the directory ${this.config.dataDir}?`,
                    ],
                });
            }
            throw error;
        }
    }
    async link(p, { install }) {
        const c = await Config.load(resolve(p));
        ux.action.start(`${this.config.name}: linking plugin ${c.name}`);
        this.isValidPlugin(c);
        // refresh will cause yarn.lock to install dependencies, including devDeps
        if (install)
            await this.refresh({ all: false, prod: false }, c.root);
        await this.add({ name: c.name, root: c.root, type: 'link' });
    }
    async list() {
        const pjson = await this.pjson();
        return pjson.oclif.plugins;
    }
    async maybeUnfriendlyName(name) {
        const unfriendly = this.unfriendlyName(name);
        this.debug(`checking registry for expanded package name ${unfriendly}`);
        if (unfriendly && (await this.npmHasPackage(unfriendly))) {
            return unfriendly;
        }
        this.debug(`expanded package name ${unfriendly} not found, using given package name ${name}`);
        return name;
    }
    async pjson() {
        const pjson = await this.readPJSON();
        const plugins = pjson ? this.normalizePlugins(pjson.oclif.plugins) : [];
        return {
            ...initPJSON,
            ...pjson,
            oclif: {
                ...initPJSON.oclif,
                ...pjson?.oclif,
                plugins,
            },
        };
    }
    /**
     * If a yarn.lock or oclif.lock exists at the root, refresh dependencies by
     * rerunning yarn. If options.prod is true, only install production dependencies.
     *
     * As of v9 npm will always ignore the yarn.lock during `npm pack`]
     * (see https://github.com/npm/cli/issues/6738). To get around this plugins can
     * rename yarn.lock to oclif.lock before running `npm pack` using `oclif lock`.
     *
     * We still check for the existence of yarn.lock since it could be included if a plugin was
     * packed using yarn or v8 of npm. Plugins installed directly from a git url will also
     * have a yarn.lock.
     *
     * @param options {prod: boolean, all: boolean}
     * @param roots string[]
     * @returns Promise<void>
     */
    async refresh(options, ...roots) {
        ux.action.status = 'Refreshing user plugins...';
        const doRefresh = async (root) => {
            await this.yarn.exec(options.prod ? ['--prod'] : [], {
                cwd: root,
                noSpinner: true,
                silent: true,
                verbose: false,
            });
        };
        const pluginRoots = [...roots];
        if (options.all) {
            const userPluginsRoots = this.config
                .getPluginsList()
                .filter((p) => p.type === 'user')
                .map((p) => p.root);
            pluginRoots.push(...userPluginsRoots);
        }
        const deduped = [...new Set(pluginRoots)];
        await Promise.all(deduped.map(async (r) => {
            if (await fileExists(join(r, 'yarn.lock'))) {
                this.debug(`yarn.lock exists at ${r}. Installing prod dependencies`);
                await doRefresh(r);
            }
            else if (await fileExists(join(r, 'oclif.lock'))) {
                this.debug(`oclif.lock exists at ${r}. Installing prod dependencies`);
                await rename(join(r, 'oclif.lock'), join(r, 'yarn.lock'));
                await doRefresh(r);
            }
            else {
                this.debug(`no yarn.lock or oclif.lock exists at ${r}. Skipping dependency refresh`);
            }
        }));
    }
    async remove(name) {
        const pjson = await this.pjson();
        if (pjson.dependencies)
            delete pjson.dependencies[name];
        await this.savePJSON({
            ...pjson,
            oclif: {
                ...pjson.oclif,
                plugins: pjson.oclif.plugins.filter((p) => p.name !== name),
            },
        });
    }
    unfriendlyName(name) {
        if (name.includes('@'))
            return;
        const { pluginPrefix, scope } = this.config.pjson.oclif;
        if (!scope)
            return;
        return `@${scope}/${pluginPrefix ?? 'plugin'}-${name}`;
    }
    async uninstall(name) {
        try {
            const pjson = await this.pjson();
            if ((pjson.oclif.plugins ?? []).some((p) => typeof p === 'object' && p.type === 'user' && p.name === name)) {
                await this.yarn.exec(['remove', name], {
                    cwd: this.config.dataDir,
                    silent: this.silent,
                    verbose: this.verbose,
                });
            }
        }
        catch (error) {
            ux.warn(error);
        }
        finally {
            await this.remove(name);
        }
    }
    async update() {
        // eslint-disable-next-line unicorn/no-await-expression-member
        let plugins = (await this.list()).filter((p) => p.type === 'user');
        if (plugins.length === 0)
            return;
        // migrate deprecated plugins
        const aliases = this.config.pjson.oclif.aliases || {};
        for (const [name, to] of Object.entries(aliases)) {
            const plugin = plugins.find((p) => p.name === name);
            if (!plugin)
                continue;
            // eslint-disable-next-line no-await-in-loop
            if (to)
                await this.install(to);
            // eslint-disable-next-line no-await-in-loop
            await this.uninstall(name);
            plugins = plugins.filter((p) => p.name !== name);
        }
        if (plugins.some((p) => Boolean(p.url))) {
            await this.yarn.exec(['upgrade'], {
                cwd: this.config.dataDir,
                silent: this.silent,
                verbose: this.verbose,
            });
        }
        const npmPlugins = plugins.filter((p) => !p.url);
        const jitPlugins = this.config.pjson.oclif.jitPlugins ?? {};
        const modifiedPlugins = [];
        if (npmPlugins.length > 0) {
            await this.yarn.exec([
                'add',
                ...npmPlugins.map((p) => {
                    // a not valid tag indicates that it's a dist-tag like 'latest'
                    if (!valid(p.tag))
                        return `${p.name}@${p.tag}`;
                    if (p.tag && valid(p.tag) && jitPlugins[p.name] && gt(p.tag, jitPlugins[p.name])) {
                        // The user has installed a version of the JIT plugin that is newer than the one
                        // specified by the root plugin's JIT configuration. In this case, we want to
                        // keep the version installed by the user.
                        return `${p.name}@${p.tag}`;
                    }
                    const tag = jitPlugins[p.name] ?? p.tag;
                    modifiedPlugins.push({ ...p, tag });
                    return `${p.name}@${tag}`;
                }),
            ], { cwd: this.config.dataDir, silent: this.silent, verbose: this.verbose });
        }
        await this.refresh({ all: true, prod: true });
        await this.add(...modifiedPlugins);
    }
    async createPJSON() {
        if (!(await fileExists(this.pjsonPath))) {
            this.debug(`creating ${this.pjsonPath} with pjson: ${JSON.stringify(initPJSON, null, 2)}`);
            await this.savePJSON(initPJSON);
        }
    }
    isValidPlugin(p) {
        if (p.valid)
            return true;
        if (this.config.plugins.get('@oclif/plugin-legacy') ||
            // @ts-expect-error because _base is private
            p._base.includes('@oclif/plugin-legacy')) {
            return true;
        }
        throw new Errors.CLIError('plugin is invalid', {
            suggestions: [
                'Plugin failed to install because it does not appear to be a valid CLI plugin.\nIf you are sure it is, contact the CLI developer noting this error.',
            ],
        });
    }
    normalizePlugins(input) {
        const plugins = (input ?? []).map((p) => {
            if (typeof p === 'string') {
                return {
                    name: p,
                    tag: 'latest',
                    type: 'user',
                };
            }
            return p;
        });
        return uniqWith(plugins, 
        // @ts-expect-error because typescript doesn't think it's possible for a plugin to have the `link` type here
        (a, b) => a.name === b.name || (a.type === 'link' && b.type === 'link' && a.root === b.root));
    }
    async npmHasPackage(name, throwOnNotFound = false) {
        const nodeExecutable = await findNode(this.config.root);
        const npmCli = await findNpm();
        this.debug(`Using node executable located at: ${nodeExecutable}`);
        this.debug(`Using npm executable located at: ${npmCli}`);
        const command = `${nodeExecutable} ${npmCli} show ${name} dist-tags`;
        let npmShowResult;
        try {
            const { default: shelljs } = await import('shelljs');
            npmShowResult = shelljs.exec(command, { silent: true });
        }
        catch {
            throw new Errors.CLIError(`Could not run npm show for ${name}`);
        }
        if (npmShowResult?.code !== 0) {
            this.debug(npmShowResult?.stderr);
            if (throwOnNotFound)
                throw new Errors.CLIError(`${name} does not exist in the registry.`);
            return false;
        }
        this.debug(`Found ${name} in the registry.`);
        return true;
    }
    get pjsonPath() {
        return join(this.config.dataDir, 'package.json');
    }
    async readPJSON() {
        try {
            return JSON.parse(await readFile(this.pjsonPath, 'utf8'));
        }
        catch (error) {
            this.debug(error);
            const err = error;
            if (err.code !== 'ENOENT')
                process.emitWarning(err);
        }
    }
    async savePJSON(pjson) {
        this.debug(`saving pjson at ${this.pjsonPath}`, JSON.stringify(pjson, null, 2));
        await mkdir(dirname(this.pjsonPath), { recursive: true });
        await writeFile(this.pjsonPath, JSON.stringify(pjson, null, 2));
    }
}