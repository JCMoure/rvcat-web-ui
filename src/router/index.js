import { createRouter, createWebHistory } from 'vue-router'
import SimulatorView                      from '../views/SimulatorView.vue'

const router = createRouter({
  history: createWebHistory('#'),
  routes: [
    {
      path: '/',
      name: 'simulator',
      component: SimulatorView,
    }
  ],
})

export default router
