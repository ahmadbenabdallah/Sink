<script setup lang="ts">
import type { McpLevel } from '#shared/types/auth'
import type { ConnectorCreateResponse } from '#shared/types/connector'
import { Loader2 } from '@lucide/vue'
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
const revealPanel = useTemplateRef<{ focus: () => void }>('revealPanel')
const formId = `connector-create-${useId()}`

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
  if (isOpen) {
    revealed.value = false
    connectorName.value = ''
  }
  else {
    // Closing the dialog is the end of the token's one showing.
    token.value = null
  }
})
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
      :form-id="formId"
      :submitting="submitting"
      @submit="submit"
    />
    <DashboardConnectorsTokenReveal v-else ref="revealPanel" :token="token ?? ''" />

    <!-- The same buttons as the link editor: stacked on phones, side by side from sm. -->
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
          :disabled="submitting"
          @click="open = false"
        >
          {{ $t('common.cancel') }}
        </Button>
        <Button
          type="submit"
          :form="formId"
          :disabled="submitting"
          :aria-busy="submitting"
          class="
            w-full
            sm:w-auto
          "
        >
          <Loader2 v-if="submitting" class="motion-safe:animate-spin" aria-hidden="true" />
          {{ $t('connectors.form.submit') }}
        </Button>
      </template>
    </template>
  </ResponsiveModal>
</template>
