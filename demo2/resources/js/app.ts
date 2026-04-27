import { createInertiaApp } from "@inertiajs/vue3";
import { createApp, h } from "vue";
import "../css/app.css";

const APP_NAME = "Arpon's Vue Demo 1";

createInertiaApp({
  title: (title) => (title ? `${title} | ${APP_NAME}` : APP_NAME),
  progress: {
    delay: 0,
    color: "#3b82f6",
    includeCSS: true,
    showSpinner: false
  },
  resolve: (name) => {
    const pages = import.meta.glob("./Pages/**/*.vue", { eager: true });
    const page = pages[`./Pages/${name}.vue`];
    if (!page) {
      throw new Error(`Page "${name}" was not found.`);
    }
    return page.default;
  },
  setup({ el, App, props, plugin }) {
    createApp({ render: () => h(App, props) }).use(plugin).mount(el);
  }
});
