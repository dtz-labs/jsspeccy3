import path from 'path';
import { fileURLToPath } from 'url';

const projectRoot = path.dirname(fileURLToPath(import.meta.url));

export default (env, argv) => {
    /* `npm run build:js` runs webpack with no --mode, so this falls back to
    production and existing builds are unaffected. */
    const mode = argv.mode || 'production';
    const devtool = (mode === 'development') ? 'cheap-module-source-map' : false;

    return [
        {
            output: {
                filename: 'jsspeccy/jsspeccy.js',
            },
            name: 'jsspeccy',
            entry: './runtime/jsspeccy.js',
            mode,
            devtool,
            module: {
                rules: [
                    {
                        test: /\.svg$/,
                        loader: 'svg-inline-loader',
                    }
                ],
            },
            /* With an array config, the dev server reads devServer from a single
            compiler, so it belongs here rather than on the worker. */
            devServer: {
                host: '0.0.0.0',
                port: 8080,
                allowedHosts: 'all',
                /* Serves the wasm core, the ROMs and index.html, which are built by
                the other three stages of the build; watching it means their output
                triggers a reload too. */
                static: {
                    directory: path.resolve(projectRoot, 'dist'),
                    watch: true,
                },
                /* Nothing calls module.hot.accept, so HMR would fall back to a full
                reload anyway - only noisily. */
                hot: false,
                liveReload: true,
            },
        },
        {
            output: {
                filename: 'jsspeccy/jsspeccy-worker.js',
            },
            name: 'worker',
            entry: './runtime/worker.js',
            mode,
            devtool,
        },
    ];
};
