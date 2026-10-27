import DefaultTheme from 'vitepress/theme'
import type { Theme } from 'vitepress'
import { h } from 'vue'
import F2zFreeTo from './components/F2zFreeTo.vue'
import './style.css'
import { useNavScroll } from './composables/useNavScroll'

import F2zBadge from './components/F2zBadge.vue'
import F2zCard from './components/F2zCard.vue'
import F2zCardGrid from './components/F2zCardGrid.vue'
import F2zCta from './components/F2zCta.vue'
import F2zPath from './components/F2zPath.vue'
import F2zSteps from './components/F2zSteps.vue'
import F2zLinkRow from './components/F2zLinkRow.vue'

export default {
  extends: DefaultTheme,
  Layout() {
    return h(DefaultTheme.Layout, null, {
      'home-hero-info-before': () => h(F2zFreeTo),
    })
  },
  setup() {
    useNavScroll()
  },
  enhanceApp({ app }) {
    app.component('F2zBadge', F2zBadge)
    app.component('F2zCard', F2zCard)
    app.component('F2zCardGrid', F2zCardGrid)
    app.component('F2zCta', F2zCta)
    app.component('F2zPath', F2zPath)
    app.component('F2zSteps', F2zSteps)
    app.component('F2zLinkRow', F2zLinkRow)
  },
} satisfies Theme
