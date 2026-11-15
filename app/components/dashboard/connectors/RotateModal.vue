<script setup lang="ts">
import type { ConnectorRotateResponse, ConnectorView } from '#shared/types/connector'
import { Loader2 } from '@lucide/vue'
import { toast } from 'vue-sonner'

const props = defineProps<{
  connector: ConnectorView | null
  rotate: (id: string) => Promise<ConnectorRotateResponse>
}>()

const emit = defineEmits<{
  closeAutoFocus: [event: Event]
}>()

const open = defineModel<boolean>('open', { default: false })

const { t } = useI18n()
const rotating = shallowRef(false)
/** The new token, held here only while the dialog is open. */
const token = shallowRef<string | null>(null)
/** Kept apart from the token, so clearing it on close does not flip back to the question while animating shut. */
const revealed = shallowRef(false)
const revealPanel = useTemplateRef<{ focus: () => void }>('revealPanel')

watch(open, (isOpen) => {
  if (isOpen)
    revealed.value = false
  else
    token.value = null
})

async function confirmRotate() {
  // A second click while the first request runs would rotate twice.
  if (rotating.value || !props.connector)
    return

  rotating.value = true
  try {
    token.value = (await props.rotate(props.connector.id)).token
    revealed.value = true
    await nextTick()
    revealPanel.value?.focus()
  }
  catch (error) {
    toast.error(t('connectors.rotate.failed'), {
      description: getErrorMessage(error, t('common.unexpected_error')),
    })
  }
  finally {
    rotating.value = false
  }
}
</script>

<template>
  <!-- While the new token is on screen, the dialog closes only through "Done". -->
  <ResponsiveModal
    v-model:open="open"
    :title="revealed ? $t('connectors.rotate.reveal_title') : $t('connectors.rotate.title', { name: connector?.name ?? '' })"
    :description="revealed ? connector?.name : $t('connectors.rotate.description')"
    :prevent-close="rotating || token !== null"
    @close-auto-focus="emit('closeAutoFocus', $event)"
  >
    <DashboardConnectorsTokenReveal v-if="revealed" ref="revealPanel" :token="token ?? ''" />

    <!--
      The same buttons as the link editor: stacked on phones, side by side from
      sm. Rotate stays red: it stops the current token at once.
    -->
    <template #footer>
      <Button
        v-if="revealed"
        type="button"
        class="
          w-full
          sm:w-auto
        "
        @click="open = false"
      >
        {{ $t('connectors.reveal.done') }}
      </Button>
      <template v-else>
        <Button
          type="button"
          variant="secondary"
          class="
            w-full
            sm:w-auto
          "
          :disabled="rotating"
          @click="open = false"
        >
          {{ $t('common.cancel') }}
        </Button>
        <Button
          type="button"
          variant="destructive"
          class="
            w-full
            sm:w-auto
          "
          :disabled="rotating"
          :aria-busy="rotating"
          @click="confirmRotate"
        >
          <Loader2 v-if="rotating" class="motion-safe:animate-spin" aria-hidden="true" />
          {{ $t('connectors.rotate.confirm') }}
        </Button>
      </template>
    </template>
  </ResponsiveModal>
</template>
