<script setup lang="ts">
import type { ConnectorUsage, ConnectorView } from '#shared/types/connector'
import { Plus, RefreshCw } from '@lucide/vue'

const { t, locale } = useI18n()
// The server refuses every connector change in preview mode; say so up front.
// The setting is a string that is empty when off, and an empty string on
// `disabled` would disable the button, so it is turned into a boolean here.
const previewMode = !!useRuntimeConfig().public.previewMode
const { connectors, reserved, dailyCallLimit, loading, loaded, loadError, load, create, revoke, rename, rotate, remove } = useConnectors()

const createOpen = shallowRef(false)
const createButton = useTemplateRef<{ $el: HTMLElement }>('createButton')

type Action = 'rename' | 'rotate' | 'revoke' | 'remove'
/** The connector the open dialog acts on. */
const target = shallowRef<ConnectorView | null>(null)
const dialog = shallowRef<Action | null>(null)
function dialogOpen(action: Action) {
  return computed({
    get: () => dialog.value === action,
    set: (open: boolean) => {
      if (!open && dialog.value === action)
        dialog.value = null
    },
  })
}
const renameOpen = dialogOpen('rename')
const rotateOpen = dialogOpen('rotate')
const revokeOpen = dialogOpen('revoke')
const removeOpen = dialogOpen('remove')

function openAction(connector: ConnectorView, action: Action) {
  target.value = connector
  dialog.value = action
}

const RESERVED_LABELS = { 'site-token': 'connectors.reserved.site_token', 'access': 'connectors.reserved.access' } as const

// A dialog opened from a row menu returns focus to that row's menu button
// while the row exists, and to "New MCP connector" once it is removed.
function returnFocus(event: Event) {
  event.preventDefault()
  const id = target.value?.id
  const rowButton = id ? document.querySelector(`[data-connector-actions="${CSS.escape(id)}"]`) : null
  if (rowButton instanceof HTMLButtonElement && !rowButton.disabled)
    rowButton.focus()
  else
    createButton.value?.$el.focus()
}

function lastUsedText(usage: ConnectorUsage): string {
  const state = connectorUsageState(usage)
  if (state === 'unavailable')
    return t('connectors.usage_unavailable')
  return state === 'never' ? t('connectors.never_used') : shortDate(usage.lastUsedAt!, locale.value)
}

function callsText(usage: ConnectorUsage): string {
  return usage.calls7d === null ? t('connectors.usage_unavailable') : formatNumber(usage.calls7d, locale.value)
}

onMounted(load)
</script>

<template>
  <Card>
    <CardHeader>
      <div class="flex flex-wrap items-start justify-between gap-4">
        <div class="space-y-1.5">
          <CardTitle><h2>{{ $t('connectors.title') }}</h2></CardTitle>
          <CardDescription>{{ $t('connectors.description') }}</CardDescription>
          <CardDescription v-if="dailyCallLimit !== null">
            {{ $t('connectors.daily_limit', { limit: formatNumber(dailyCallLimit, locale) }) }}
          </CardDescription>
        </div>
        <Button ref="createButton" :disabled="previewMode" @click="createOpen = true">
          <Plus aria-hidden="true" class="mr-2 size-4" />
          {{ $t('connectors.create') }}
        </Button>
      </div>
    </CardHeader>

    <CardContent class="space-y-4">
      <Alert v-if="loadError" variant="destructive">
        <AlertTitle>{{ $t('connectors.load_failed') }}</AlertTitle>
        <AlertDescription class="space-y-3">
          <p>{{ getErrorMessage(loadError, $t('common.unexpected_error')) }}</p>
          <Button variant="outline" size="sm" :disabled="loading" @click="load">
            <RefreshCw aria-hidden="true" class="mr-2 size-4" :class="{ 'motion-safe:animate-spin': loading }" />
            {{ $t('common.try_again') }}
          </Button>
        </AlertDescription>
      </Alert>

      <div
        v-if="!loaded && loading" role="status" aria-busy="true" class="
          space-y-2
        "
      >
        <Skeleton v-for="row in 3" :key="row" class="h-10 w-full" />
      </div>

      <Table v-else-if="loaded" class="min-w-3xl">
        <TableHeader>
          <TableRow>
            <TableHead>{{ $t('connectors.table.name') }}</TableHead>
            <TableHead>{{ $t('connectors.table.level') }}</TableHead>
            <TableHead>{{ $t('connectors.table.created') }}</TableHead>
            <TableHead>{{ $t('connectors.table.last_used') }}</TableHead>
            <TableHead class="text-right">
              {{ $t('connectors.table.calls_7d') }}
            </TableHead>
            <TableHead>{{ $t('connectors.table.status') }}</TableHead>
            <TableHead class="text-right">
              <span class="sr-only">{{ $t('connectors.table.actions') }}</span>
            </TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          <!-- Callers that are not connectors: never revocable. -->
          <TableRow
            v-for="caller in reserved" :key="caller.id" class="
              text-muted-foreground
            "
          >
            <TableCell class="font-medium">
              {{ $t(RESERVED_LABELS[caller.id]) }}
            </TableCell>
            <TableCell>
              <Badge variant="secondary">
                {{ $t('connectors.level.full.label') }}
              </Badge>
            </TableCell>
            <TableCell><span aria-hidden="true">—</span></TableCell>
            <TableCell>{{ lastUsedText(caller) }}</TableCell>
            <TableCell class="text-right tabular-nums">
              {{ callsText(caller) }}
            </TableCell>
            <TableCell><span aria-hidden="true">—</span></TableCell>
            <TableCell />
          </TableRow>

          <TableRow
            v-for="connector in connectors"
            :key="connector.id"
            :class="{ 'text-muted-foreground': connector.revokedAt !== null }"
          >
            <TableCell>
              <div class="max-w-64 font-medium wrap-break-word">
                {{ connector.name }}
              </div>
              <div class="font-mono text-xs text-muted-foreground">
                sink_mcp_{{ connector.hint }}…
              </div>
            </TableCell>
            <TableCell>
              <Badge variant="secondary">
                {{ $t(`connectors.level.${connector.level}.label`) }}
              </Badge>
            </TableCell>
            <TableCell>
              <div>{{ shortDate(connector.createdAt, locale) }}</div>
              <div
                v-if="connector.rotatedAt !== null" class="
                  text-xs text-muted-foreground
                "
              >
                {{ $t('connectors.table.rotated', { date: shortDate(connector.rotatedAt, locale) }) }}
              </div>
            </TableCell>
            <TableCell>{{ lastUsedText(connector) }}</TableCell>
            <TableCell class="text-right tabular-nums">
              {{ callsText(connector) }}
            </TableCell>
            <TableCell>
              <Badge :variant="connector.revokedAt === null ? 'secondary' : 'outline'">
                {{ connector.revokedAt === null ? $t('connectors.status.active') : $t('connectors.status.revoked') }}
              </Badge>
            </TableCell>
            <TableCell class="text-right">
              <DashboardConnectorsActionsMenu
                :connector="connector"
                :disabled="previewMode"
                @action="openAction(connector, $event)"
              />
            </TableCell>
          </TableRow>

          <TableEmpty v-if="connectors.length === 0" :colspan="7">
            <p class="font-medium">
              {{ $t('connectors.empty') }}
            </p>
            <p class="text-sm text-muted-foreground">
              {{ $t('connectors.empty_description') }}
            </p>
          </TableEmpty>
        </TableBody>
      </Table>
    </CardContent>
  </Card>

  <DashboardConnectorsCreateModal v-model:open="createOpen" :create="create" />
  <DashboardConnectorsRenameDialog
    v-model:open="renameOpen"
    :connector="target"
    :rename="rename"
    @close-auto-focus="returnFocus"
  />
  <DashboardConnectorsRotateModal
    v-model:open="rotateOpen"
    :connector="target"
    :rotate="rotate"
    @close-auto-focus="returnFocus"
  />
  <DashboardConnectorsRevokeDialog
    v-model:open="revokeOpen"
    :connector="target"
    :revoke="revoke"
    @close-auto-focus="returnFocus"
  />
  <DashboardConnectorsRemoveDialog
    v-model:open="removeOpen"
    :connector="target"
    :remove="remove"
    @close-auto-focus="returnFocus"
  />
</template>
