<template>
  <Head title="About">
    <meta name="description" :content="description" />
    <meta name="tag" content="tags" />
  </Head>

  <AppLayout :app-name="appName" :current-path="currentPath">
    <section class="mx-auto w-full max-w-3xl rounded-2xl border border-slate-800 bg-slate-900/80 p-8">
      <p class="mb-3 inline-flex rounded-md bg-sky-600/15 px-3 py-1 text-xs font-semibold uppercase tracking-[0.14em] text-sky-300">
        About this demo
      </p>
      <h1 class="text-3xl font-bold tracking-tight text-white">Vue Adapter Demo</h1>
      <p class="mt-4 text-sm leading-relaxed text-slate-300">
        This folder is a dedicated Vue sample for <code>arpon-inertia-bridge</code>.
        It shows the middleware running with <code>vite.adapter: "vue"</code> while keeping the same server API.
      </p>
    </section>
  </AppLayout>
</template>

<script setup>
import { Head, usePage } from "@inertiajs/vue3";
import AppLayout from "../Components/AppLayout.vue";

defineProps({
  description: {
    type: String,
    required: true
  }
});

const page = usePage();
const appName = page.props.appName;
const currentPath = page.props.currentPath;
</script>
