<script setup lang="ts">
import { ChevronRight } from '@lucide/vue'
import { useSidebar } from '@/components/ui/sidebar'

const props = defineProps<{
  platformItems: {
    title: string
    url: string
    icon: Component
    isActive?: boolean
  }[]
  settingsItems: {
    title: string
    url: string
    icon: Component
    isActive?: boolean
    children?: { title: string, url: string, isActive?: boolean }[]
  }[]
}>()

const { t } = useI18n()
const { isMobile, setOpenMobile, state } = useSidebar()

/** Which groups are open. A group opens by itself when one of its pages becomes current. */
const openGroups = ref<Record<string, boolean>>({})
watch(() => props.settingsItems.map(item => [item.title, item.isActive] as const), (items) => {
  for (const [title, isActive] of items) {
    if (isActive)
      openGroups.value[title] = true
  }
}, { immediate: true })
const route = useRoute()

watch(() => route.path, () => {
  if (isMobile.value) {
    setOpenMobile(false)
  }
})
</script>

<template>
  <SidebarGroup>
    <SidebarGroupLabel>{{ $t('sidebar.platform') }}</SidebarGroupLabel>
    <SidebarMenu>
      <SidebarMenuItem v-for="item in platformItems" :key="item.title">
        <SidebarMenuButton
          as-child
          :tooltip="t(item.title)"
          :is-active="item.isActive"
          class="
            hover:rounded-4xl
            data-active:rounded-4xl
          "
        >
          <NuxtLink :to="item.url">
            <component :is="item.icon" aria-hidden="true" />
            <span>{{ t(item.title) }}</span>
          </NuxtLink>
        </SidebarMenuButton>
      </SidebarMenuItem>
    </SidebarMenu>
  </SidebarGroup>

  <SidebarGroup>
    <SidebarGroupLabel>{{ $t('sidebar.settings') }}</SidebarGroupLabel>
    <SidebarMenu>
      <SidebarMenuItem v-for="item in settingsItems" :key="item.title">
        <!--
          An item with pages under it opens a submenu. Collapsed to icons there
          is no room for one, so it links to its first page instead.
        -->
        <Collapsible
          v-if="item.children?.length && (state === 'expanded' || isMobile)"
          v-model:open="openGroups[item.title]"
          class="group/collapsible"
        >
          <CollapsibleTrigger as-child>
            <SidebarMenuButton
              :tooltip="t(item.title)"
              :is-active="item.isActive"
              class="
                hover:rounded-4xl
                data-active:rounded-4xl
              "
            >
              <component :is="item.icon" aria-hidden="true" />
              <span>{{ t(item.title) }}</span>
              <ChevronRight
                aria-hidden="true"
                class="
                  ml-auto transition-transform
                  group-data-[state=open]/collapsible:rotate-90
                  motion-reduce:transition-none
                "
              />
            </SidebarMenuButton>
          </CollapsibleTrigger>
          <CollapsibleContent>
            <SidebarMenuSub>
              <SidebarMenuSubItem v-for="child in item.children" :key="child.title">
                <SidebarMenuSubButton as-child :is-active="child.isActive">
                  <NuxtLink :to="child.url">
                    <span>{{ t(child.title) }}</span>
                  </NuxtLink>
                </SidebarMenuSubButton>
              </SidebarMenuSubItem>
            </SidebarMenuSub>
          </CollapsibleContent>
        </Collapsible>
        <SidebarMenuButton
          v-else
          as-child
          :tooltip="t(item.title)"
          :is-active="item.isActive"
          class="
            hover:rounded-4xl
            data-active:rounded-4xl
          "
        >
          <NuxtLink :to="item.children?.[0]?.url ?? item.url">
            <component :is="item.icon" aria-hidden="true" />
            <span>{{ t(item.title) }}</span>
          </NuxtLink>
        </SidebarMenuButton>
      </SidebarMenuItem>
    </SidebarMenu>
  </SidebarGroup>
</template>
