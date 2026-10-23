import { defineConfig, mergeConfig } from 'vitest/config'
import viteConfig from './vite.config'
import { DOM_TEST_FILES } from './src/test/domTestFiles'

/**
 * The web tests run in two environments.
 *
 * The suite has more logic tests than component tests, and a jsdom
 * environment per file is the largest cost of the suite - building one takes
 * longer than the tests of a logic file take. The logic tests therefore run
 * in the node environment, and the files that need a browser - the `.tsx`
 * component tests and the ones listed in `DOM_TEST_FILES` - run in jsdom.
 *
 * The setup file serves both: it only installs the browser shims when there
 * is a browser.
 */
export default mergeConfig(
    viteConfig,
    defineConfig({
        test: {
            globals: false,
            setupFiles: ['./src/test/setup.ts'],
            projects: [
                {
                    extends: true,
                    test: {
                        name: 'dom',
                        environment: 'jsdom',
                        include: ['src/**/*.test.tsx', ...DOM_TEST_FILES],
                    },
                },
                {
                    extends: true,
                    test: {
                        name: 'node',
                        environment: 'node',
                        include: ['src/**/*.test.ts'],
                        exclude: ['**/node_modules/**', '**/.git/**', ...DOM_TEST_FILES],
                    },
                },
            ],
        },
    })
)
