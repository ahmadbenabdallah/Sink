<script setup lang="ts">
import type { ConnectorView } from '#shared/types/connector'
import { Loader2 } from '@lucide/vue'
import { toast } from 'vue-sonner'

const props = defineProps<{
  connector: ConnectorView | null
  revoke: (id: string) => Promise<void>
}>()

const emit = defineEmits<{
  /** The dialog has closed and is about to return focus; the page decides where. */
  closeAutoFocus: [event: Event]
}>()

const open = defineModel<boolean>('open', { default: false })

const { t } = useI18n()
const revoking = shallowRef(false)

async function confirmRevoke() {
  if (revoking.value || !props.connector)
    return

  revoking.value = true
  try {
    await props.revoke(props.connector.id)
    open.value = false
    toast(t('connectors.revoke.success'))
  }
  catch (error) {
    toast.error(t('connectors.revoke.failed'), {
      description: getErrorMessage(error, t('common.unexpected_error')),
    })
  }
  finally {
    revoking.value = false
  }
}

function updateOpen(value: boolean) {
  if (!value && revoking.value)
    return

  open.value = value
}

function handleEscapeKeyDown(event: KeyboardEvent) {
  if (revoking.value)
    event.preventDefault()
}
</script>

<template>
  <AlertDialog :open="open" @update:open="updateOpen">
    <AlertDialogContent
      @close-auto-focus="emit('closeAutoFocus', $event)"
      @escape-key-down="handleEscapeKeyDown"
    >
      <AlertDialogHeader>
        <AlertDialogTitle class="wrap-break-word">
          {{ $t('connectors.revoke.title', { name: connector?.name ?? '' }) }}
        </AlertDialogTitle>
        <AlertDialogDescription>
          {{ $t('connectors.revoke.description') }}
        </AlertDialogDescription>
      </AlertDialogHeader>
      <AlertDialogFooter>
        <AlertDialogCancel :disabled="revoking">
          {{ $t('common.cancel') }}
        </AlertDialogCancel>
        <Button
          variant="destructive"
          :disabled="revoking"
          :aria-busy="revoking"
          @click.prevent="confirmRevoke"
        >
          <Loader2 v-if="revoking" class="motion-safe:animate-spin" aria-hidden="true" />
          {{ $t('connectors.revoke.confirm') }}
        </Button>
      </AlertDialogFooter>
    </AlertDialogContent>
  </AlertDialog>
</template>
