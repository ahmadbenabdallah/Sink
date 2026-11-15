<script setup lang="ts">
import type { ConnectorView } from '#shared/types/connector'
import { Loader2 } from '@lucide/vue'
import { toast } from 'vue-sonner'
import { CONNECTOR_NAME_MAX_LENGTH, ConnectorNameSchema } from '#shared/schemas/connector'

const props = defineProps<{
  connector: ConnectorView | null
  rename: (id: string, name: string) => Promise<void>
}>()

const emit = defineEmits<{
  closeAutoFocus: [event: Event]
}>()

const open = defineModel<boolean>('open', { default: false })

const { t } = useI18n()
const name = shallowRef('')
const invalid = shallowRef(false)
const saving = shallowRef(false)

watch(open, (isOpen) => {
  if (isOpen) {
    name.value = props.connector?.name ?? ''
    invalid.value = false
  }
})

// The message goes as soon as the name is edited; it is checked again on save.
watch(name, () => {
  invalid.value = false
})

async function save() {
  if (saving.value || !props.connector)
    return
  // The same rules as on create, checked before sending.
  const parsed = ConnectorNameSchema.safeParse(name.value)
  invalid.value = !parsed.success
  if (!parsed.success)
    return

  saving.value = true
  try {
    await props.rename(props.connector.id, parsed.data)
    open.value = false
    toast(t('connectors.rename.success'))
  }
  catch (error) {
    toast.error(t('connectors.rename.failed'), {
      description: getErrorMessage(error, t('common.unexpected_error')),
    })
  }
  finally {
    saving.value = false
  }
}
</script>

<template>
  <ResponsiveModal
    v-model:open="open"
    :title="$t('connectors.rename.title', { name: connector?.name ?? '' })"
    :prevent-close="saving"
    @close-auto-focus="emit('closeAutoFocus', $event)"
  >
    <form
      id="connector-rename-form" class="w-full space-y-4 px-1" :aria-busy="saving"
      @submit.prevent="save"
    >
      <Field :data-invalid="invalid || undefined">
        <FieldLabel for="connector-rename">
          {{ $t('connectors.form.name') }}
        </FieldLabel>
        <Input
          id="connector-rename"
          v-model="name"
          :aria-invalid="invalid || undefined"
          :aria-describedby="invalid ? 'connector-rename-error' : undefined"
          :maxlength="CONNECTOR_NAME_MAX_LENGTH"
          autocomplete="off"
        />
        <p
          v-if="invalid" id="connector-rename-error" class="
            text-sm text-destructive
          "
        >
          {{ $t('connectors.form.name_invalid', { max: CONNECTOR_NAME_MAX_LENGTH }) }}
        </p>
      </Field>
    </form>

    <!-- The same buttons as the link editor: stacked on phones, side by side from sm. -->
    <template #footer>
      <Button
        type="button"
        variant="secondary"
        class="
          w-full
          sm:w-auto
        "
        :disabled="saving"
        @click="open = false"
      >
        {{ $t('common.cancel') }}
      </Button>
      <Button
        type="submit"
        form="connector-rename-form"
        :disabled="saving"
        :aria-busy="saving"
        class="
          w-full
          sm:w-auto
        "
      >
        <Loader2 v-if="saving" class="motion-safe:animate-spin" aria-hidden="true" />
        {{ $t('connectors.rename.submit') }}
      </Button>
    </template>
  </ResponsiveModal>
</template>
