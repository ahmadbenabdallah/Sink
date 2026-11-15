<script setup lang="ts">
import type { ConnectorView } from '#shared/types/connector'
import { Loader2 } from '@lucide/vue'
import { toast } from 'vue-sonner'

const props = defineProps<{
  connector: ConnectorView | null
  remove: (id: string) => Promise<void>
}>()

const emit = defineEmits<{
  /** The dialog has closed and is about to return focus; the page decides where. */
  closeAutoFocus: [event: Event]
}>()

const open = defineModel<boolean>('open', { default: false })

const { t } = useI18n()
const removing = shallowRef(false)

async function confirmRemove() {
  if (removing.value || !props.connector)
    return

  removing.value = true
  try {
    await props.remove(props.connector.id)
    open.value = false
    toast(t('connectors.remove.success'))
  }
  catch (error) {
    toast.error(t('connectors.remove.failed'), {
      description: getErrorMessage(error, t('common.unexpected_error')),
    })
  }
  finally {
    removing.value = false
  }
}

function updateOpen(value: boolean) {
  if (!value && removing.value)
    return
  open.value = value
}

function handleEscapeKeyDown(event: KeyboardEvent) {
  if (removing.value)
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
          {{ $t('connectors.remove.title', { name: connector?.name ?? '' }) }}
        </AlertDialogTitle>
        <AlertDialogDescription>
          {{ $t('connectors.remove.description') }}
        </AlertDialogDescription>
      </AlertDialogHeader>
      <AlertDialogFooter>
        <AlertDialogCancel :disabled="removing">
          {{ $t('common.cancel') }}
        </AlertDialogCancel>
        <Button
          variant="destructive"
          :disabled="removing"
          :aria-busy="removing"
          @click.prevent="confirmRemove"
        >
          <Loader2 v-if="removing" class="motion-safe:animate-spin" aria-hidden="true" />
          {{ $t('connectors.remove.confirm') }}
        </Button>
      </AlertDialogFooter>
    </AlertDialogContent>
  </AlertDialog>
</template>
