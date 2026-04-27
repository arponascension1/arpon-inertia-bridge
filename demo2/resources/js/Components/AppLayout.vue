<template>
  <div class="relative min-h-screen bg-slate-950 text-slate-100">
    <div
      aria-hidden="true"
      class="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_top,rgba(30,41,59,0.7),transparent_60%)]"
    />
    <div class="relative z-10 flex min-h-screen flex-col">
      <header class="sticky top-0 z-30 border-b border-slate-700 bg-slate-900/95 shadow-lg backdrop-blur">
        <div class="mx-auto flex w-full max-w-6xl flex-wrap items-center gap-3 px-6 py-3">
          <Link href="/" class="mr-1 flex min-w-0 items-center gap-2 text-white">
            <span class="grid h-9 w-9 shrink-0 place-items-center rounded-md border border-sky-400/40 bg-sky-600 text-sm font-bold">
              {{ appName.charAt(0) }}
            </span>
            <div class="min-w-0">
              <span class="block truncate text-base font-semibold">{{ appName }}</span>
              <span class="block text-[11px] text-slate-400">Vue Adapter Demo</span>
            </div>
          </Link>

          <nav class="ml-auto flex items-center gap-1">
            <Link href="/" :class="navLinkClass(currentPath === '/')">Home</Link>
            <Link href="/about" :class="navLinkClass(currentPath === '/about')">About</Link>
          </nav>
        </div>
      </header>

      <main class="mx-auto w-full max-w-6xl flex-1 px-6 py-10">
        <slot />
      </main>
    </div>
  </div>
</template>

<script setup>
import { Link } from "@inertiajs/vue3";

defineProps({
  appName: {
    type: String,
    required: true
  },
  currentPath: {
    type: String,
    required: true
  }
});

function navLinkClass(isActive) {
  return isActive
    ? "rounded-md border border-slate-500/80 bg-slate-700 px-3 py-2 text-sm font-semibold text-white shadow-sm"
    : "rounded-md border border-transparent px-3 py-2 text-sm font-medium text-slate-200 transition hover:border-slate-600 hover:bg-slate-800 hover:text-white";
}
</script>
