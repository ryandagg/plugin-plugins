import { Command } from '@oclif/core';
import Plugins from '../../plugins.js';
export default class PluginsUninstall extends Command {
    static aliases: string[];
    static args: {
        plugin: import("@oclif/core/lib/interfaces/parser.js").Arg<string | undefined, Record<string, unknown>>;
    };
    static description: string;
    static flags: {
        help: import("@oclif/core/lib/interfaces/parser.js").BooleanFlag<void>;
        verbose: import("@oclif/core/lib/interfaces/parser.js").BooleanFlag<boolean>;
    };
    static help: string;
    static strict: boolean;
    static usage: string;
    plugins: Plugins;
    run(): Promise<void>;
}