import { onMounted, onUnmounted } from 'vue'

/**
 * Hide navbar on scroll down, show on scroll up.
 * Mirrors ts/svelte/free2z/src/lib/components/layout/Navbar.svelte
 */
export function useNavScroll() {
  onMounted(() => {
    let lastY = window.scrollY
    let visible = true

    const threshold = 20
    const upThreshold = 10
    const minDelta = 5

    const setVisible = (next: boolean) => {
      if (visible === next) return
      visible = next
      document.documentElement.classList.toggle('f2z-nav-hidden', !next)
    }

    const isMobileMenuOpen = () =>
      !!document.querySelector('.VPNavBar.screen-open') ||
      !!document.getElementById('VPNavScreen')

    const onScroll = () => {
      // Keep nav visible while the mobile screen menu is open
      if (isMobileMenuOpen()) {
        setVisible(true)
        lastY = window.scrollY
        return
      }

      const y = window.scrollY
      const delta = y - lastY

      if (Math.abs(delta) < minDelta) return

      if (delta > 0 && y > threshold) {
        setVisible(false)
      } else if (delta < -upThreshold || y < threshold) {
        setVisible(true)
      }

      lastY = y
    }

    setVisible(true)
    window.addEventListener('scroll', onScroll, { passive: true })

    onUnmounted(() => {
      window.removeEventListener('scroll', onScroll)
      document.documentElement.classList.remove('f2z-nav-hidden')
    })
  })
}
