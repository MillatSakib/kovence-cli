"use strict";

module.exports = [
    {
        ignores: [
            "node_modules/**",
            ".kovence/**",
            ".ai_harness/**",
            "coverage/**",
            "website/**",
            ".next/**",
            "**/.next/**",
            "out/**",
            "**/out/**",
        ],
    },
    {
        files: ["**/*.js"],
        languageOptions: {
            ecmaVersion: 2024,
            sourceType: "commonjs",
            globals: {
                process: "readonly",
                console: "readonly",
                Buffer: "readonly",
                __dirname: "readonly",
                __filename: "readonly",
                module: "readonly",
                require: "readonly",
                exports: "readonly",
                setTimeout: "readonly",
                clearTimeout: "readonly",
                setInterval: "readonly",
                clearInterval: "readonly",
                setImmediate: "readonly",
                fetch: "readonly",
                AbortController: "readonly",
                AbortSignal: "readonly",
                URL: "readonly",
                TextDecoder: "readonly",
                Intl: "readonly",
            },
        },
        rules: {
            "no-undef": "error",
            "no-unused-vars": [
                "warn",
                { argsIgnorePattern: "^_", varsIgnorePattern: "^_", caughtErrorsIgnorePattern: "^_" },
            ],
            "no-dupe-keys": "error",
            "no-unreachable": "error",
            "no-constant-condition": ["warn", { checkLoops: false }],
        },
    },
];
