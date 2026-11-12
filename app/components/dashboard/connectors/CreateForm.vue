<script setup lang="ts">
import type { McpLevel } from '#shared/types/auth'
import { Loader, Plus, TriangleAlert } from '@lucide/vue'
import { useForm } from '@tanstack/vue-form'
import { CONNECTOR_NAME_MAX_LENGTH, CreateConnectorSchema } from '#shared/schemas/connector'
import { MCP_LEVELS } from '#shared/types/auth'

defineProps<{
  submitting: boolean
}>()

const emit = defineEmits<{
  submit: [input: { name: string, level: McpLevel }]
}>()

const { t } = useI18n()

const defaultValues: { name: string, level: McpLevel } = {
  name: '',
  // The least a connector can do is the safest thing to start from.
  level: 'read',
}

const form = useForm({
  defaultValues,
  onSubmit: ({ value }) => {
    emit('submit', CreateConnectorSchema.parse(value))
  },
})

const validateName = makeZodValidator(CreateConnectorSchema.shape.name, () => t('connectors.form.name_invalid', { max: CONNECTOR_NAME_MAX_LENGTH }))
const selectedLevel = form.useStore(state => state.values.level)

function selectLevel(value: unknown) {
  if (MCP_LEVELS.includes(value as McpLevel))
    form.setFieldValue('level', value as McpLevel)
}
</script>

<template>
  <form class="w-full space-y-6 px-1" :aria-busy="submitting" @submit.prevent="form.handleSubmit">
    <FieldGroup>
      <form.Field
        v-slot="{ field }"
        name="name"
        :validators="{ onBlur: validateName, onSubmit: validateName }"
      >
        <Field :data-invalid="isInvalid(field) || undefined">
          <FieldLabel for="connector-name">
            {{ $t('connectors.form.name') }}
          </FieldLabel>
          <Input
            id="connector-name"
            :name="field.name"
            :model-value="field.state.value"
            :aria-invalid="getAriaInvalid(field)"
            :aria-describedby="isInvalid(field) ? 'connector-name-error' : undefined"
            :placeholder="$t('connectors.form.name_placeholder')"
            :maxlength="CONNECTOR_NAME_MAX_LENGTH"
            autocomplete="off"
            @blur="field.handleBlur"
            @update:model-value="field.handleChange(String($event))"
          />
          <FieldError
            v-if="isInvalid(field)"
            id="connector-name-error"
            :errors="field.state.meta.errors"
          />
        </Field>
      </form.Field>

      <Field>
        <FieldLabel id="connector-level-label">
          {{ $t('connectors.form.level') }}
        </FieldLabel>
        <RadioGroup
          :model-value="selectedLevel"
          aria-labelledby="connector-level-label"
          class="gap-3"
          @update:model-value="selectLevel"
        >
          <label
            v-for="level in MCP_LEVELS"
            :key="level"
            :for="`connector-level-${level}`"
            class="
              flex cursor-pointer items-start gap-3 rounded-md border p-3
              has-data-[state=checked]:border-primary
            "
          >
            <RadioGroupItem
              :id="`connector-level-${level}`"
              :value="level"
              :aria-label="$t(`connectors.level.${level}.label`)"
              :aria-describedby="`connector-level-${level}-description`"
              class="mt-0.5"
            />
            <span :id="`connector-level-${level}-description`" class="space-y-1">
              <span class="block text-sm font-medium">{{ $t(`connectors.level.${level}.label`) }}</span>
              <span class="block text-sm text-muted-foreground">{{ $t(`connectors.level.${level}.description`) }}</span>
              <span
                v-if="level === 'full'"
                class="flex items-center gap-1.5 text-sm text-destructive"
              >
                <TriangleAlert aria-hidden="true" class="size-4 shrink-0" />
                {{ $t('connectors.level.full_warning') }}
              </span>
            </span>
          </label>
        </RadioGroup>
      </Field>
    </FieldGroup>

    <Button
      type="submit"
      :disabled="submitting"
      :aria-busy="submitting"
    >
      <Loader
        v-if="submitting" aria-hidden="true" class="
          mr-2 size-4
          motion-safe:animate-spin
        "
      />
      <Plus v-else aria-hidden="true" class="mr-2 size-4" />
      <template v-if="submitting">
        {{ $t('connectors.form.submitting') }}
      </template>
      <template v-else>
        {{ $t('connectors.form.submit') }}
      </template>
    </Button>
  </form>
</template>
