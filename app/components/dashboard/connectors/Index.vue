<script setup lang="ts">
import type { ConnectorUsage, ConnectorView } from '#shared/types/connector'
import { Plus, RefreshCw } from '@lucide/vue'

const { t, locale } = useI18n()
const { connectors, reserved, dailyCallLimit, loading, loaded, loadError, load, create, revoke } = useConnectors()

const createOpen = shallowRef(false)
const revokeOpen = shallowRef(false)
const revokeTarget = shallowRef<ConnectorView | null>(null)
const createButton = useTemplateRef<{ $el: HTMLElement }>('createButton')

const RESERVED_LABELS = { 'site-token': 'connectors.reserved.site_token', 'access': 'connectors.reserved.access' } as const

function askRevoke(connector: ConnectorView) {
  revokeTarget.value = connector
  revokeOpen.value = true
}

// A revoked row loses its Revoke button, which is where focus would return
// to. Send it somewhere that still exists.
function handleRevokeClosed(event: Event, revoked: boolean) {
  if (!revoked)
    return
  event.preventDefault()
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
        <Button ref="createButton" @click="createOpen = true">
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
          <!-- Callers that are not connectors: always present, never revocable. -->
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
            <TableCell>{{ shortDate(connector.createdAt, locale) }}</TableCell>
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
              <Button
                v-if="connector.revokedAt === null"
                variant="outline"
                size="sm"
                :aria-label="$t('connectors.revoke.title', { name: connector.name })"
                @click="askRevoke(connector)"
              >
                {{ $t('connectors.revoke.action') }}
              </Button>
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
  <DashboardConnectorsRevokeDialog
    v-model:open="revokeOpen"
    :connector="revokeTarget"
    :revoke="revoke"
    @close-auto-focus="handleRevokeClosed"
  />
</template>
