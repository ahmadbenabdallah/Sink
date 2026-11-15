<script setup lang="ts">
import { toast } from 'vue-sonner'

const props = defineProps<{
  /** The token to show once. Empty while the dialog around it closes. */
  token: string
}>()

const { t } = useI18n()
const copiedKey = shallowRef<string | null>(null)
const panel = useTemplateRef<HTMLElement>('panel')
let copiedTimer: ReturnType<typeof setTimeout> | undefined

const items = computed(() => {
  if (!props.token)
    return []
  const snippets = connectorSnippets(window.location.origin, props.token)
  return [
    { key: 'token', label: t('connectors.reveal.token'), text: props.token },
    { key: 'claude', label: t('connectors.reveal.claude_code'), text: snippets.claudeCode },
    { key: 'json', label: t('connectors.reveal.json_config'), text: snippets.json },
  ]
})

async function copy(key: string, text: string) {
  clearTimeout(copiedTimer)
  const copied = await copyToClipboard(text)
  copiedKey.value = copied ? key : null
  // The text stays on screen, so it can still be selected and copied by hand.
  if (!copied)
    toast.error(t('connectors.reveal.copy_failed'))
  copiedTimer = setTimeout(() => {
    copiedKey.value = null
  }, 2000)
}

watch(() => props.token, () => {
  clearTimeout(copiedTimer)
  copiedKey.value = null
})

onBeforeUnmount(() => clearTimeout(copiedTimer))

defineExpose({ focus: () => panel.value?.focus() })
</script>

<template>
  <div
    ref="panel"
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
      v-for="item in items"
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
</template>
