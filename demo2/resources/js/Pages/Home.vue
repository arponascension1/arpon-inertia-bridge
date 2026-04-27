<template>
  <Head title="Home">
    <meta name="description" :content="description" />
    <meta name="test" :content="description" />
  </Head>

  <AppLayout :app-name="appName" :current-path="currentPath">
    <section class="grid gap-6 lg:grid-cols-12">
      <article class="rounded-2xl border border-slate-800 bg-slate-900/80 p-8 lg:col-span-8">
        <p class="mb-4 inline-flex rounded-md bg-sky-600/15 px-3 py-1 text-xs font-semibold uppercase tracking-[0.14em] text-sky-300">
          Vue + Inertia
        </p>
        <h1 class="mb-4 text-3xl font-bold tracking-tight text-white md:text-4xl">
          Vue adapter is active.
        </h1>
        <p class="mb-7 max-w-2xl text-base leading-relaxed text-slate-300">{{ message }}</p>
      </article>

      <aside class="space-y-6 lg:col-span-4">
        <div class="rounded-2xl border border-slate-800 bg-slate-900/80 p-6">
          <h2 class="mb-4 text-base font-semibold text-white">What this demo proves</h2>
          <ul class="space-y-3 text-sm text-slate-300">
            <li class="flex gap-2"><span class="mt-1 h-1.5 w-1.5 rounded-full bg-sky-400" />Vue client renders through Inertia</li>
            <li class="flex gap-2"><span class="mt-1 h-1.5 w-1.5 rounded-full bg-sky-400" />Server uses adapter: "vue" in dev tags</li>
            <li class="flex gap-2"><span class="mt-1 h-1.5 w-1.5 rounded-full bg-sky-400" />Same middleware API as React mode</li>
          </ul>
        </div>
      </aside>
    </section>
  </AppLayout>
</template>

<script setup>
import { Head, usePage } from "@inertiajs/vue3";
import AppLayout from "../Components/AppLayout.vue";

defineProps({
  message: {
    type: String,
    required: true
  },
  description: {
    type: String,
    required: true
  }
});

const page = usePage();
const appName = page.props.appName;
const currentPath = page.props.currentPath;
</script>
