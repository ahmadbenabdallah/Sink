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
const revealPanel = useTemplateRef<{ focus: () => void }>('revealPanel')

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
      :submitting="submitting"
      @submit="submit"
    />
    <DashboardConnectorsTokenReveal v-else ref="revealPanel" :token="token ?? ''" />

    <template v-if="revealed" #footer>
      <Button type="button" @click="open = false">
        {{ $t('connectors.reveal.done') }}
      </Button>
    </template>
  </ResponsiveModal>
</template>
