import antfu from '@antfu/eslint-config'
import eslintPluginBetterTailwindcss from 'eslint-plugin-better-tailwindcss'
import withNuxt from './.nuxt/eslint.config.mjs'

export default withNuxt(antfu(
  {
    formatters: true,
    pnpm: false,
    ignores: [
      'app/components/ui/**',
      'app/data/**',
      'public/*.json',
    ],
    rules: {
      '@typescript-eslint/ban-ts-comment': 'off',
      'no-console': 'off',
      'node/prefer-global/process': 'off',
      'vue/no-v-html': 'off',
    },
  },
  {
    // AGENTS.md: server code must never import app code; move shared code to shared/**.
    files: ['server/**'],
    rules: {
      'no-restricted-imports': ['error', {
        patterns: [{
          group: ['@/*', '~/*', '~~/app/*', '@@/app/*', '**/app/*'],
          message: 'server/** must not import app/**; use #shared/... instead.',
        }],
      }],
    },
  },
  {
    plugins: {
      'better-tailwindcss': eslintPluginBetterTailwindcss,
    },
    settings: {
      'better-tailwindcss': {
        entryPoint: './app/assets/css/tailwind.css',
      },
    },
    rules: {
      ...eslintPluginBetterTailwindcss.configs['recommended-warn'].rules,
    },
  },
))
