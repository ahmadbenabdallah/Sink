import type { DashboardRouteName } from '@/utils/dashboard-routes'
import { computed } from 'vue'
import { useRoute } from '#imports'
import { DASHBOARD_ROUTES, dashboardPageOf, isDashboardPageActive } from '@/utils/dashboard-routes'

export function useDashboardRoute() {
  const route = useRoute()

  const currentPage = computed<DashboardRouteName | ''>(() => dashboardPageOf(route.path))

  const pageTitle = computed(() => {
    const page = currentPage.value
    return page ? DASHBOARD_ROUTES[page].titleKey : 'dashboard.title'
  })

  const isActive = (page: DashboardRouteName) => isDashboardPageActive(currentPage.value, page)

  return { currentPage, pageTitle, isActive }
}
