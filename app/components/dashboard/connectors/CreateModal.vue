<script setup lang="ts">
import type { McpLevel } from '#shared/types/auth'
import type { ConnectorCreateResponse } from '#shared/types/connector'
import { toast } from 'vue-sonner'

const props = defineProps<{
  create: (input: { name: string, level: McpLevel }) => Promise<ConnectorCreateResponse>
}>()

const open = defineModel<boolean>('open', { default: false })

const { t } = useI18n()
const submitting = shallowRef(false)
/** The token of the connector just created. It is held here only while the dialog is open. */
const token = shallowRef<string | null>(null)
/**
 * Whether the dialog has moved on from the form to showing the token. Kept
 * apart from the token so that clearing the token on close does not flip the
 * dialog back to an empty form while it is still animating shut.
 */
const revealed = shallowRef(false)
const connectorName = shallowRef('')
const copiedKey = shallowRef<string | null>(null)
const revealPanel = useTemplateRef<HTMLElement>('revealPanel')
let copiedTimer: ReturnType<typeof setTimeout> | undefined

const snippets = computed(() => token.value ? connectorSnippets(window.location.origin, token.value) : null)
const revealItems = computed(() => token.value && snippets.value
  ? [
      { key: 'token', label: t('connectors.reveal.token'), text: token.value },
      { key: 'claude', label: t('connectors.reveal.claude_code'), text: snippets.value.claudeCode },
      { key: 'json', label: t('connectors.reveal.json_config'), text: snippets.value.json },
    ]
  : [])

async function copy(key: string, text: string) {
  clearTimeout(copiedTimer)
  copiedKey.value = await copyToClipboard(text) ? key : null
  copiedTimer = setTimeout(() => {
    copiedKey.value = null
  }, 2000)
}

async function submit(input: { name: string, level: McpLevel }) {
  if (submitting.value)
    return

  submitting.value = true
  try {
    const created = await props.create(input)
    connectorName.value = created.connector.name
    token.value = created.token
    revealed.value = true
    // The form the user was in is gone; put focus where the token is.
    await nextTick()
    revealPanel.value?.focus()
  }
  catch (error) {
    toast.error(t('connectors.create_dialog.failed'), {
      description: getErrorMessage(error, t('common.unexpected_error')),
    })
  }
  finally {
    submitting.value = false
  }
}

watch(open, (isOpen) => {
  clearTimeout(copiedTimer)
  copiedKey.value = null
  if (isOpen) {
    revealed.value = false
    connectorName.value = ''
  }
  else {
    // Closing the dialog is the end of the token's one showing.
    token.value = null
  }
})

onBeforeUnmount(() => clearTimeout(copiedTimer))
</script>

<template>
  <!--
    While the token is on screen the dialog closes only through "Done": a stray
    click outside or the Escape key would otherwise lose it for good.
  -->
  <ResponsiveModal
    v-model:open="open"
    :title="revealed ? $t('connectors.reveal.title') : $t('connectors.create_dialog.title')"
    :description="revealed ? connectorName : $t('connectors.create_dialog.description')"
    :prevent-close="submitting || token !== null"
  >
    <DashboardConnectorsCreateForm
      v-if="!revealed"
      :submitting="submitting"
      @submit="submit"
    />

    <div
      v-else
      ref="revealPanel"
      tabindex="-1"
      class="
        w-full space-y-5 px-1
        focus:outline-none
      "
    >
      <Alert>
        <AlertDescription>{{ $t('connectors.reveal.once_notice') }}</AlertDescription>
      </Alert>

      <div
        v-for="item in revealItems"
        :key="item.key"
        class="space-y-2"
      >
        <div class="flex items-center justify-between gap-2">
          <p :id="`connector-reveal-${item.key}`" class="text-sm font-medium">
            {{ item.label }}
          </p>
          <Button
            type="button"
            variant="outline"
            size="sm"
            :aria-label="`${$t('connectors.reveal.copy')}: ${item.label}`"
            @click="copy(item.key, item.text)"
          >
            {{ copiedKey === item.key ? $t('connectors.reveal.copied') : $t('connectors.reveal.copy') }}
          </Button>
        </div>
        <pre
          role="group"
          tabindex="0"
          :aria-labelledby="`connector-reveal-${item.key}`"
          class="
            max-h-40 overflow-auto rounded-md bg-muted p-3 font-mono text-xs
            break-all whitespace-pre-wrap
          "
        >{{ item.text }}</pre>
      </div>

      <p class="sr-only" aria-live="polite">
        {{ copiedKey ? $t('connectors.reveal.copied') : '' }}
      </p>
    </div>

    <template v-if="revealed" #footer>
      <Button type="button" @click="open = false">
        {{ $t('connectors.reveal.done') }}
      </Button>
    </template>
  </ResponsiveModal>
</template>
