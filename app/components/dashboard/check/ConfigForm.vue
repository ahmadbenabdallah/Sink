<script setup lang="ts">
import type { LinkCheckConfig } from '@/types'
import { useForm } from '@tanstack/vue-form'
import { LINK_CHECK_LIMITS, LinkCheckConfigSchema } from '#shared/schemas/link-check'

defineProps<{
  checking: boolean
  loadingLinks: boolean
  hasLinks: boolean
  hasResults: boolean
  exportDisabled: boolean
}>()

const emit = defineEmits<{
  start: [config: LinkCheckConfig]
  stop: []
  clear: []
  export: []
  reload: []
}>()

interface LinkCheckConfigFormValues {
  timeout: number | undefined
  batchSize: number | undefined
}

const defaultValues: LinkCheckConfigFormValues = {
  timeout: 6,
  batchSize: 6,
}

const form = useForm({
  defaultValues,
  onSubmit: ({ value }) => {
    emit('start', LinkCheckConfigSchema.parse(value))
  },
})

const { t } = useI18n()

function makeRangeValidator(name: keyof typeof LINK_CHECK_LIMITS) {
  return makeZodValidator(LinkCheckConfigSchema.shape[name], () => t('check.config.number_out_of_range', LINK_CHECK_LIMITS[name]))
}

const validateTimeout = makeRangeValidator('timeout')
const validateBatchSize = makeRangeValidator('batchSize')
const clearDialogOpen = shallowRef(false)

function getNumberInputValue(value: unknown) {
  return typeof value === 'number' && Number.isFinite(value) ? value : ''
}

function getNumberInputChangeValue(event: Event) {
  const input = event.target as HTMLInputElement
  return input.value === '' ? undefined : input.valueAsNumber
}
</script>

<template>
  <form class="space-y-4" @submit.prevent="form.handleSubmit">
    <FieldGroup
      class="
        grid gap-4
        md:grid-cols-2
      "
    >
      <form.Field
        v-slot="{ field }"
        name="timeout"
        :validators="{ onBlur: validateTimeout, onSubmit: validateTimeout }"
      >
        <Field :data-invalid="isInvalid(field)">
          <FieldLabel :for="field.name">
            {{ $t('check.config.timeout') }}
          </FieldLabel>
          <Input
            :id="field.name"
            :name="field.name"
            type="number"
            :min="LINK_CHECK_LIMITS.timeout.min"
            :max="LINK_CHECK_LIMITS.timeout.max"
            step="1"
            inputmode="numeric"
            autocomplete="off"
            :model-value="getNumberInputValue(field.state.value)"
            :aria-invalid="getAriaInvalid(field)"
            :aria-describedby="`${field.name}-description${isInvalid(field) ? ` ${field.name}-error` : ''}`"
            @blur="field.handleBlur"
            @input="field.handleChange(getNumberInputChangeValue($event))"
          />
          <FieldDescription :id="`${field.name}-description`">
            {{ $t('check.config.timeout_description') }}
          </FieldDescription>
          <FieldError v-if="isInvalid(field)" :id="`${field.name}-error`" :errors="field.state.meta.errors" />
        </Field>
      </form.Field>

      <form.Field
        v-slot="{ field }"
        name="batchSize"
        :validators="{ onBlur: validateBatchSize, onSubmit: validateBatchSize }"
      >
        <Field :data-invalid="isInvalid(field)">
          <FieldLabel :for="field.name">
            {{ $t('check.config.batch_size') }}
          </FieldLabel>
          <Input
            :id="field.name"
            :name="field.name"
            type="number"
            :min="LINK_CHECK_LIMITS.batchSize.min"
            :max="LINK_CHECK_LIMITS.batchSize.max"
            step="1"
            inputmode="numeric"
            autocomplete="off"
            :model-value="getNumberInputValue(field.state.value)"
            :aria-invalid="getAriaInvalid(field)"
            :aria-describedby="`${field.name}-description${isInvalid(field) ? ` ${field.name}-error` : ''}`"
            @blur="field.handleBlur"
            @input="field.handleChange(getNumberInputChangeValue($event))"
          />
          <FieldDescription :id="`${field.name}-description`">
            {{ $t('check.config.batch_size_description') }}
          </FieldDescription>
          <FieldError v-if="isInvalid(field)" :id="`${field.name}-error`" :errors="field.state.meta.errors" />
        </Field>
      </form.Field>
    </FieldGroup>

    <div class="flex flex-wrap gap-2">
      <Button
        type="submit"
        :disabled="checking || loadingLinks || !hasLinks"
      >
        {{ checking ? $t('check.actions.checking') : $t('check.actions.start') }}
      </Button>
      <Button
        type="button"
        variant="destructive"
        :disabled="!checking"
        @click="emit('stop')"
      >
        {{ $t('check.actions.stop') }}
      </Button>
      <Button
        type="button"
        variant="outline"
        :disabled="checking || loadingLinks"
        @click="emit('reload')"
      >
        {{ loadingLinks ? $t('check.actions.loading') : $t('check.actions.reload') }}
      </Button>
      <Button
        type="button"
        variant="destructive"
        :disabled="checking || !hasResults"
        @click="clearDialogOpen = true"
      >
        {{ $t('check.actions.clear') }}
      </Button>
      <Button
        type="button"
        variant="outline"
        :disabled="exportDisabled"
        @click="emit('export')"
      >
        {{ $t('check.actions.export') }}
      </Button>
    </div>
  </form>

  <DashboardCheckClearResultsDialog
    v-model:open="clearDialogOpen"
    @confirm="emit('clear')"
  />
</template>
