import { Interfaces } from '@oclif/core';
type CompareTypes = boolean | number | string | undefined;
export declare function sortBy<T>(arr: T[], fn: (i: T) => CompareTypes | CompareTypes[]): T[];
export declare function uniq<T>(arr: T[]): T[];
export declare function uniqWith<T>(arr: T[], fn: (a: T, b: T) => boolean): T[];
/**
 * Get the path to the node executable
 * If using a macos/windows/tarball installer it will use the node version included in it.
 * If that fails (or CLI was installed via npm), this will resolve to the global node installed in the system.
 * @param root - The root path of the CLI (this.config.root).
 * @returns The path to the node executable.
 */
export declare function findNode(root: string): Promise<string>;
/**
 * Get the path to the npm CLI file.
 * This will always resolve npm to the pinned version in `@oclif/plugin-plugins/package.json`.
 *
 * @returns The path to the `npm/bin/npm-cli.js` file.
 */
export declare function findNpm(): Promise<string>;
export declare class YarnMessagesCache {
    private static errors;
    private static instance;
    private static warnings;
    static getInstance(): YarnMessagesCache;
    addErrors(...errors: string[]): void;
    addWarnings(...warnings: string[]): void;
    flush(plugin?: Interfaces.Config | undefined): void;
}
export {};