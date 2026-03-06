import diiaConfig from '@diia-inhouse/eslint-config'

/**  @type {import('eslint').Linter.Config}  */
export default [
    ...diiaConfig,
    {
        ignores: ['*.js', '*.mjs', 'node_modules', 'dist', 'coverage', 'src/generated/**'],
    },
    {
        rules: {
            'unicorn/prefer-node-protocol': 'off',
        },
    },
    {
        languageOptions: {
            parserOptions: {
                project: ['./tsconfig.json', './tests/tsconfig.json'],
                ecmaVersion: 2022,
                sourceType: `module`,
            },
        },
    },
]
