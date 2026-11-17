<script setup lang="ts">
import { Globe } from '@lucide/vue'
import { GitHubIcon } from 'vue3-simple-icons'

// The 404 page passes the new name; the other pages keep the site title.
defineProps<{ brand?: string }>()

const { title, linkedin, website, source } = useAppConfig()
</script>

<template>
  <div class="flex min-h-svh flex-col overflow-x-clip">
    <a
      href="#main-content"
      class="
        fixed top-4 left-4 z-50 -translate-y-24 rounded-md bg-background px-4
        py-2 text-sm font-medium shadow-lg
        focus:translate-y-0
        focus-visible:ring-2 focus-visible:ring-ring
      "
    >
      {{ $t('layouts.links.skip_to_content') }}
    </a>

    <!-- Header -->
    <header>
      <div
        class="
          fixed z-20 w-full border-b bg-background/80
          pt-[env(safe-area-inset-top)] text-foreground backdrop-blur-3xl
        "
      >
        <div class="mx-auto max-w-6xl px-6">
          <div
            class="
              flex items-center justify-between gap-6 py-3
              lg:py-4
            "
          >
            <NuxtLink
              to="/"
              class="text-xl font-black"
            >
              {{ brand ?? title }}
            </NuxtLink>

            <!-- ponytail: docs, API reference and GitHub stars hidden for now; git history has them. -->
            <div class="flex items-center gap-3">
              <SwitchLanguage />
              <SwitchTheme />
            </div>
          </div>
        </div>
      </div>
    </header>

    <!-- Main Content -->
    <main
      id="main-content"
      class="flex flex-1 flex-col pt-[calc(5rem+env(safe-area-inset-top))]"
    >
      <slot />
    </main>

    <!-- Footer -->
    <footer
      class="
        border-t bg-background pt-8 pb-[calc(2rem+env(safe-area-inset-bottom))]
        text-foreground
      "
    >
      <div class="mx-auto max-w-6xl px-6">
        <div
          class="
            flex flex-col items-center gap-6 pt-2
            md:flex-row md:justify-between
          "
        >
          <NuxtLink
            to="/"
            class="text-xl font-black"
          >
            {{ brand ?? title }}
          </NuxtLink>

          <nav
            :aria-label="$t('layouts.links.resources_aria_label')"
            class="flex flex-wrap justify-center gap-2 text-sm"
          >
            <Button as-child variant="ghost" size="icon">
              <a
                :href="linkedin"
                target="_blank"
                rel="noopener noreferrer"
                :title="$t('layouts.footer.social.linkedin')"
                :aria-label="$t('layouts.footer.social.linkedin')"
              >
                <!-- LinkedIn's logo; the icon packs dropped brand logos. -->
                <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
                  <path d="M20.447 20.452h-3.554v-5.569c0-1.328-.027-3.037-1.852-3.037-1.853 0-2.136 1.445-2.136 2.939v5.667H9.351V9h3.414v1.561h.046c.477-.9 1.637-1.85 3.37-1.85 3.601 0 4.267 2.37 4.267 5.455v6.286zM5.337 7.433a2.062 2.062 0 1 1 0-4.125 2.062 2.062 0 0 1 0 4.125zM7.119 20.452H3.555V9h3.564v11.452zM22.225 0H1.771C.792 0 0 .774 0 1.729v20.542C0 23.227.792 24 1.771 24h20.451C23.2 24 24 23.227 24 22.271V1.729C24 .774 23.2 0 22.222 0h.003z" />
                </svg>
              </a>
            </Button>
            <Button as-child variant="ghost" size="icon">
              <a
                :href="website"
                target="_blank"
                rel="noopener noreferrer"
                :title="$t('layouts.footer.social.website')"
                :aria-label="$t('layouts.footer.social.website')"
              >
                <Globe aria-hidden="true" />
              </a>
            </Button>
            <Button as-child variant="ghost" size="icon">
              <a
                :href="source"
                target="_blank"
                rel="noopener noreferrer"
                :title="$t('layouts.footer.social.source')"
                :aria-label="$t('layouts.footer.social.source')"
              >
                <GitHubIcon aria-hidden="true" />
              </a>
            </Button>
          </nav>
        </div>
      </div>
    </footer>
  </div>
</template>
