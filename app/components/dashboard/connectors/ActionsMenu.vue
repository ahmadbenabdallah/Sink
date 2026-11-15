<script setup lang="ts">
import type { ConnectorView } from '#shared/types/connector'
import { Ban, Ellipsis, KeyRound, PencilLine, Trash2 } from '@lucide/vue'
import { useMediaQuery } from '@vueuse/core'

type Action = 'rename' | 'rotate' | 'revoke' | 'remove'

const props = defineProps<{
  connector: ConnectorView
  /** The server refuses changes in preview mode; the button says so instead. */
  disabled: boolean
}>()

const emit = defineEmits<{
  action: [action: Action]
}>()

const isDesktop = useMediaQuery('(min-width: 640px)')
const revoked = computed(() => props.connector.revokedAt !== null)
const menuOpen = shallowRef(false)
/** Set while the menu closes to open a dialog, so focus goes to the dialog, not back to this button. */
const choosing = shallowRef(false)

// The menu closes first and the dialog opens on the next tick, as on the Links page.
async function choose(action: Action) {
  choosing.value = true
  menuOpen.value = false
  await nextTick()
  emit('action', action)
}

function handleCloseAutoFocus(event: Event) {
  if (choosing.value) {
    event.preventDefault()
    choosing.value = false
  }
}
</script>

<template>
  <DropdownMenu v-model:open="menuOpen">
    <!-- A disabled button shows no tooltip, so the reason sits on a wrapper. -->
    <span :title="disabled ? $t('errors.preview_mode') : undefined">
      <DropdownMenuTrigger as-child>
        <Button
          :data-connector-actions="connector.id"
          variant="ghost"
          :size="isDesktop ? 'icon' : 'icon-lg'"
          :disabled="disabled"
          :aria-label="$t('connectors.actions.open', { name: connector.name })"
        >
          <Ellipsis aria-hidden="true" />
        </Button>
      </DropdownMenuTrigger>
    </span>
    <DropdownMenuContent align="end" :hide-when-detached="false" @close-auto-focus="handleCloseAutoFocus">
      <template v-if="!revoked">
        <DropdownMenuItem @select.prevent="choose('rename')">
          <PencilLine aria-hidden="true" />
          {{ $t('connectors.actions.rename') }}
        </DropdownMenuItem>
        <DropdownMenuItem @select.prevent="choose('rotate')">
          <KeyRound aria-hidden="true" />
          {{ $t('connectors.actions.rotate') }}
        </DropdownMenuItem>
        <DropdownMenuItem @select.prevent="choose('revoke')">
          <Ban aria-hidden="true" />
          {{ $t('connectors.actions.revoke') }}
        </DropdownMenuItem>
      </template>
      <DropdownMenuLabel
        v-else class="max-w-56 text-xs font-normal text-muted-foreground"
      >
        {{ $t('connectors.actions.revoked_only') }}
      </DropdownMenuLabel>
      <DropdownMenuSeparator />
      <DropdownMenuItem variant="destructive" @select.prevent="choose('remove')">
        <Trash2 aria-hidden="true" />
        {{ $t('connectors.actions.remove') }}
      </DropdownMenuItem>
    </DropdownMenuContent>
  </DropdownMenu>
</template>
