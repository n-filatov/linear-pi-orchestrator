// SVG icon paths from Heroicons (MIT)
const IC = {
  chevron: `<svg class="w-3.5 h-3.5 shrink-0 transition-transform duration-150" fill="none" stroke="currentColor" stroke-width="2.5" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M9 18l6-6-6-6"/></svg>`,
  plus:    `<svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" stroke-width="2.5" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M12 4v16m8-8H4"/></svg>`,
  trash:   `<svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"/></svg>`,
  save:    `<svg class="w-4 h-4" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M8 7H5a2 2 0 00-2 2v9a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-3m-1 4l-3 3m0 0l-3-3m3 3V4"/></svg>`,
  warning: `<svg class="w-4 h-4 shrink-0" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M12 9v4m0 4h.01M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z"/></svg>`,
  check:   `<svg class="w-4 h-4 shrink-0" fill="none" stroke="currentColor" stroke-width="2.5" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M5 13l4 4L19 7"/></svg>`,
  stop:    `<svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M21 12a9 9 0 11-18 0 9 9 0 0118 0zM9 10a1 1 0 011-1h4a1 1 0 011 1v4a1 1 0 01-1 1h-4a1 1 0 01-1-1v-4z"/></svg>`,
  reload:  `<svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"/></svg>`,
  send:    `<svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M12 19l9 2-9-18-9 18 9-2zm0 0v-8"/></svg>`,
  terminal:`<svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M8 9l3 3-3 3m5 0h3M4 5h16a1 1 0 011 1v12a1 1 0 01-1 1H4a1 1 0 01-1-1V6a1 1 0 011-1z"/></svg>`,
  feed:    `<svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M4 6h16M4 12h16M4 18h7"/></svg>`,
};

export function renderDashboardHtml(projectName: string): string {
  const p = projectName;
  return `<!DOCTYPE html>
<html lang="en" data-theme="night">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Task Relay — ${p}</title>
<link href="https://cdn.jsdelivr.net/npm/daisyui@4.12.14/dist/full.min.css" rel="stylesheet">
<script src="https://cdn.tailwindcss.com"></script>
<script defer src="https://unpkg.com/alpinejs@3.14.8/dist/cdn.min.js"></script>
<style>
  body { font-family: ui-monospace, 'Cascadia Code', 'Fira Code', monospace; }
  [x-cloak] { display: none !important; }
  .rotate-90 { transform: rotate(90deg); }
  .form-textarea { font-size: 12px; line-height: 1.5; }
</style>
</head>
<body x-data="relay()" x-init="boot()" x-cloak class="flex flex-col h-screen overflow-hidden bg-base-100">

<!-- Navbar -->
<div class="navbar bg-base-200 border-b border-base-300 min-h-0 px-4 py-2 shrink-0 gap-2">
  <div class="flex items-center gap-2 flex-1">
    <span class="font-bold text-primary text-sm">&#9670; Task Relay</span>
    <span class="text-base-content/40 text-sm">/ ${p}</span>
  </div>
  <div class="flex items-center gap-4 text-xs text-base-content/60">
    <span class="flex items-center gap-1.5">
      <span class="w-2 h-2 rounded-full inline-block"
        :class="daemon === 'running' ? 'bg-success' : daemon === 'checking' ? 'bg-warning' : 'bg-error'"></span>
      <span x-text="daemon === 'running' ? 'daemon running' : daemon === 'checking' ? 'checking…' : 'daemon stopped'"></span>
    </span>
    <span><span class="text-base-content font-medium" x-text="activeRuns"></span> active</span>
    <span><span class="text-base-content font-medium" x-text="totalRuns"></span> total</span>
  </div>
</div>

<!-- Tab bar -->
<div class="tabs tabs-bordered bg-base-200 border-b border-base-300 px-4 shrink-0 gap-0">
  <a class="tab tab-sm font-medium" :class="mainTab === 'workers' && 'tab-active'" @click="mainTab = 'workers'">Workers</a>
  <a class="tab tab-sm font-medium" :class="mainTab === 'workflows' && 'tab-active'" @click="switchToWorkflows()">
    Workflows
    <span class="badge badge-xs badge-ghost ml-1.5" x-show="workflows.length" x-text="workflows.length"></span>
  </a>
  <a class="tab tab-sm font-medium" :class="mainTab === 'plugins' && 'tab-active'" @click="switchToPlugins()">
    Plugins
    <span class="badge badge-xs badge-error ml-1.5" x-show="pluginProblems() > 0" x-text="pluginProblems()"></span>
  </a>
  <a class="tab tab-sm font-medium" :class="mainTab === 'config' && 'tab-active'" @click="switchToConfig()">Configuration</a>
</div>

<!-- ─── Workers panel ─── -->
<div x-show="mainTab === 'workers'" class="flex-1 overflow-auto p-4">
  <div class="flex items-center justify-between mb-3">
    <span class="text-xs uppercase tracking-widest text-base-content/40 font-medium">Active &amp; recent workers</span>
    <div class="flex items-center gap-3">
      <div class="flex items-center gap-1.5">
        <template x-for="s in allStatuses" :key="s">
          <button class="badge badge-sm font-medium cursor-pointer border transition-opacity"
            :class="hiddenStatuses.indexOf(s) < 0 ? statusBadgeClass(s) : 'badge-ghost opacity-30'"
            @click="toggleStatus(s)" x-text="s"></button>
        </template>
      </div>
      <span class="text-xs text-base-content/30">auto-refresh 5s</span>
    </div>
  </div>
  <div class="overflow-x-auto rounded-lg border border-base-300">
    <table class="table table-sm">
      <thead>
        <tr class="text-base-content/40 text-xs uppercase tracking-wider">
          <th>Task</th><th>Title</th><th>Trigger</th><th>Status</th>
          <th>Started</th><th>Workspace</th><th></th>
        </tr>
      </thead>
      <tbody>
        <template x-if="loadingRuns">
          <tr><td colspan="7" class="text-center py-10 text-base-content/30">Loading…</td></tr>
        </template>
        <template x-if="!loadingRuns && filteredRuns().length === 0">
          <tr><td colspan="7" class="text-center py-10 text-base-content/30" x-text="runs.length > 0 ? 'No runs match the current filter.' : 'No runs yet.'"></td></tr>
        </template>
        <template x-for="run in filteredRuns()" :key="run.id">
          <tr class="hover">
            <td class="font-bold text-primary text-xs" x-text="run.item.id"></td>
            <td class="max-w-xs truncate text-sm" :title="run.item.title" x-text="run.item.title"></td>
            <td class="text-xs text-base-content/50" x-text="run.identity.triggerId"></td>
            <td>
              <span class="badge badge-sm font-medium"
                :class="{
                  'badge-success':  run.status === 'succeeded',
                  'badge-warning':  ['claimed','provisioning','launching'].includes(run.status),
                  'badge-info':     run.status === 'running',
                  'badge-error':    run.status === 'failed',
                  'badge-ghost':    run.status === 'stopped',
                }"
                x-text="run.status"></span>
            </td>
            <td class="text-xs text-base-content/50" x-text="fmtDate(run.claimedAt)"></td>
            <td class="text-xs text-base-content/50" :title="run.workspace && run.workspace.path" x-text="shortPath(run.workspace && run.workspace.path)"></td>
            <td class="whitespace-nowrap">
              <div class="flex items-center gap-1 justify-end">
                <button class="btn btn-xs btn-outline gap-1" x-show="canControl(run)" @click="openControl(run,'send')" title="Paste a prompt into the live worker">
                  ${IC.send} Send
                </button>
                <button class="btn btn-xs btn-outline gap-1" x-show="canControl(run)" @click="openControl(run,'exec')" title="Open a pane beside the worker">
                  ${IC.terminal} Pane
                </button>
                <button class="btn btn-xs btn-error btn-outline gap-1" x-show="canClean(run)" @click="openCleanup(run)">
                  ${IC.stop} Stop &amp; Clean
                </button>
              </div>
            </td>
          </tr>
        </template>
      </tbody>
    </table>
  </div>
</div>

<!-- ─── Workflows panel ─── -->
<div x-show="mainTab === 'workflows'" class="flex-1 overflow-auto p-4 space-y-4">
  <template x-if="loadingWorkflows">
    <div class="text-center py-10 text-base-content/30">Loading…</div>
  </template>
  <template x-if="!loadingWorkflows && workflows.length === 0">
    <div class="rounded-lg border border-base-300 p-8 text-center space-y-2">
      <p class="text-base-content/60 text-sm">No workflows configured.</p>
      <p class="text-base-content/40 text-xs">Add a <code class="text-primary">workflows:</code> block to run jobs in parallel or make one wait for another.</p>
    </div>
  </template>

  <template x-for="wf in workflows" :key="wf.id">
    <div class="rounded-lg border border-base-300 overflow-hidden">
      <div class="bg-base-200 px-4 py-2.5 flex items-center gap-3 flex-wrap">
        <span class="font-bold text-primary text-sm" x-text="wf.id"></span>
        <span class="badge badge-sm badge-ghost" x-show="!wf.enabled">disabled</span>
        <span class="text-xs text-base-content/50">
          source <span class="text-base-content/80" x-text="wf.source"></span>
          · fire <span class="text-base-content/80" x-text="wf.fire"></span>
          · timeout <span class="text-base-content/80" x-text="wf.timeoutMinutes + 'm'"></span>
        </span>
        <div class="flex-1"></div>
        <button class="btn btn-xs btn-outline gap-1" :disabled="testing === wf.id" @click="testWorkflow(wf.id)">
          ${IC.reload}
          <span x-text="testing === wf.id ? 'Testing…' : 'Test'"></span>
        </button>
      </div>

      <!-- Declared jobs -->
      <div class="px-4 py-3 border-b border-base-300">
        <div class="text-xs uppercase tracking-widest text-base-content/40 font-medium mb-2">Jobs</div>
        <div class="space-y-1.5">
          <template x-for="job in wf.jobs" :key="job.id">
            <div class="flex items-start gap-2 text-xs">
              <span class="font-medium w-36 shrink-0 truncate" :class="job.enabled ? '' : 'opacity-40 line-through'" x-text="job.id"></span>
              <span class="text-base-content/50 w-56 shrink-0 truncate" :title="job.use" x-text="job.use"></span>
              <span class="text-base-content/70 flex-1 break-all">
                <template x-for="need in job.needs">
                  <span class="badge badge-xs badge-ghost mr-1" x-text="needLabel(need)"></span>
                </template>
                <span x-show="job.if" class="text-warning" x-text="'if ' + job.if"></span>
                <span x-show="job.continueOnError" class="badge badge-xs badge-warning ml-1">continue-on-error</span>
              </span>
            </div>
          </template>
        </div>
      </div>

      <!-- Live runs -->
      <div class="px-4 py-3">
        <div class="text-xs uppercase tracking-widest text-base-content/40 font-medium mb-2">Runs</div>
        <template x-if="wf.runs.length === 0">
          <div class="text-xs text-base-content/30">No runs yet.</div>
        </template>
        <div class="space-y-2">
          <template x-for="run in wf.runs" :key="run.id">
            <div class="rounded border border-base-300/60 px-3 py-2">
              <div class="flex items-center gap-2 mb-1.5 text-xs flex-wrap">
                <span class="font-bold text-primary" x-text="run.item.id"></span>
                <span class="text-base-content/60 truncate max-w-xs" x-text="run.item.title"></span>
                <span class="badge badge-sm font-medium"
                  :class="{'badge-info':run.status==='running','badge-success':run.status==='succeeded','badge-error':run.status==='failed'}"
                  x-text="run.status"></span>
                <span class="text-base-content/30" x-text="run.identity.occurrence"></span>
                <div class="flex-1"></div>
                <span class="text-base-content/30" x-text="fmtDate(run.updatedAt)"></span>
              </div>
              <div class="flex flex-wrap gap-1.5">
                <template x-for="job in wf.jobs" :key="job.id">
                  <span class="badge badge-sm gap-1 font-normal" :class="jobBadgeClass(jobState(run, job.id).status)"
                    :title="jobTitle(jobState(run, job.id))">
                    <span class="font-medium" x-text="job.id"></span>
                    <span class="opacity-70" x-text="jobState(run, job.id).status"></span>
                  </span>
                </template>
              </div>
              <template x-if="blockedJobs(wf, run).length">
                <div class="mt-1.5 text-xs text-base-content/50">
                  waiting: <span x-text="blockedJobs(wf, run).join(' · ')"></span>
                </div>
              </template>
            </div>
          </template>
        </div>
      </div>
    </div>
  </template>
</div>

<!-- ─── Plugins panel ─── -->
<div x-show="mainTab === 'plugins'" class="flex-1 overflow-auto p-4 space-y-4">
  <div class="text-xs text-base-content/40">
    Managed directory <span class="text-base-content/70" x-text="pluginDirectory"></span>
  </div>

  <div class="rounded-lg border border-base-300 overflow-hidden">
    <div class="bg-base-200 px-4 py-2 text-xs uppercase tracking-widest text-base-content/40 font-medium">Referenced by this project</div>
    <template x-if="pluginRefs.length === 0">
      <div class="px-4 py-6 text-center text-xs text-base-content/30">This project references only built-in plugins.</div>
    </template>
    <table class="table table-sm" x-show="pluginRefs.length">
      <thead><tr class="text-base-content/40 text-xs uppercase tracking-wider"><th>Plugin</th><th>State</th><th>Used by</th></tr></thead>
      <tbody>
        <template x-for="ref in pluginRefs" :key="ref.use">
          <tr class="hover">
            <td class="text-xs font-medium" x-text="ref.use"></td>
            <td>
              <span class="badge badge-sm font-medium" :class="pluginBadgeClass(ref.state)" x-text="pluginStateLabel(ref)"></span>
            </td>
            <td class="text-xs text-base-content/50" x-text="ref.locations.join(', ')"></td>
          </tr>
        </template>
      </tbody>
    </table>
  </div>

  <div class="rounded-lg border border-base-300 overflow-hidden">
    <div class="bg-base-200 px-4 py-2 text-xs uppercase tracking-widest text-base-content/40 font-medium">Installed</div>
    <template x-if="pluginsInstalled.length === 0">
      <div class="px-4 py-6 text-center text-xs text-base-content/30">
        None installed. Run <code class="text-primary">relay plugin install &lt;package&gt;</code>.
      </div>
    </template>
    <table class="table table-sm" x-show="pluginsInstalled.length">
      <thead><tr class="text-base-content/40 text-xs uppercase tracking-wider"><th>Package</th><th>Version</th><th>Kind</th><th>Use</th><th>Entry</th></tr></thead>
      <tbody>
        <template x-for="p in pluginsInstalled" :key="p.name">
          <tr class="hover">
            <td class="text-xs font-medium" x-text="p.name"></td>
            <td class="text-xs" x-text="p.version"></td>
            <td><span class="badge badge-sm badge-ghost" x-text="p.kind"></span></td>
            <td class="text-xs text-base-content/60" x-text="p.use"></td>
            <td class="text-xs text-base-content/40" :title="p.entry" x-text="shortPath(p.entry)"></td>
          </tr>
        </template>
      </tbody>
    </table>
  </div>
</div>

<!-- ─── Config panel ─── -->
<div x-show="mainTab === 'config'" class="flex flex-1 overflow-hidden">

  <!-- Sidebar -->
  <ul class="menu menu-sm bg-base-200 border-r border-base-300 w-44 shrink-0 p-2 gap-0.5 overflow-y-auto">
    <li class="menu-title text-xs">Config</li>
    <template x-for="s in configSections" :key="s.id">
      <li>
        <a :class="configSection === s.id && 'active'" @click="configSection = s.id" x-text="s.label"></a>
      </li>
    </template>
    <li class="menu-title text-xs mt-2">Advanced</li>
    <li><a :class="configSection === 'yaml' && 'active'" @click="configSection = 'yaml'">Raw YAML</a></li>
  </ul>

  <!-- Content area -->
  <div class="flex-1 flex flex-col overflow-hidden">
    <div class="flex-1 overflow-y-auto p-5">

      <!-- External change banner -->
      <div x-show="externalChanged" class="alert alert-warning mb-4 py-2 text-sm">
        ${IC.warning}
        <span>Config changed on disk (by agent or editor).</span>
        <button class="btn btn-sm btn-ghost gap-1 ml-auto" @click="reloadConfig()">
          ${IC.reload} Reload
        </button>
      </div>

      <div x-show="loadingConfig" class="text-center py-16 text-base-content/30">Loading configuration…</div>

      <!-- PROJECT -->
      <div x-show="!loadingConfig && configSection === 'project'">
        <div class="mb-5">
          <h2 class="text-base font-semibold">Project</h2>
          <p class="text-xs text-base-content/40 mt-1">Display name used in logs and the dashboard header.</p>
        </div>
        <div class="form-control max-w-xs">
          <label class="label py-1"><span class="label-text text-xs uppercase tracking-wide">Name</span></label>
          <input class="input input-bordered input-sm" x-model="project.name" placeholder="my-project">
        </div>
      </div>

      <!-- SOURCES -->
      <div x-show="!loadingConfig && configSection === 'sources'">
        <div class="mb-5">
          <h2 class="text-base font-semibold">Sources</h2>
          <p class="text-xs text-base-content/40 mt-1">Where work items come from (Linear, command, etc.).</p>
        </div>
        <template x-for="(src, i) in sources" :key="i">
          <div class="card card-compact bg-base-200 border border-base-300 mb-3">
            <!-- Card header -->
            <div class="flex items-center gap-2 px-4 py-2.5 cursor-pointer select-none" @click.self="src.collapsed = !src.collapsed">
              <span :class="!src.collapsed && 'rotate-90'" class="text-base-content/40" @click="src.collapsed = !src.collapsed">${IC.chevron}</span>
              <input class="input input-xs bg-base-300 font-bold max-w-[160px]" x-model="src.key" placeholder="source-name" @click.stop>
              <span class="badge badge-ghost badge-sm font-mono" x-text="src.use"></span>
              <div class="ml-auto flex items-center gap-3" @click.stop>
                <label class="flex items-center gap-2 cursor-pointer">
                  <input type="checkbox" class="toggle toggle-xs toggle-primary" x-model="src.enabled">
                  <span class="text-xs text-base-content/40" x-text="src.enabled ? 'enabled' : 'disabled'"></span>
                </label>
                <button class="btn btn-xs btn-ghost text-error" @click="sources.splice(i,1)">${IC.trash}</button>
              </div>
            </div>
            <!-- Card body -->
            <div x-show="!src.collapsed" class="px-4 pb-4 border-t border-base-300 pt-4 grid grid-cols-2 gap-3">
              <div class="form-control">
                <label class="label py-1"><span class="label-text text-xs uppercase tracking-wide">Type (use)</span></label>
                <select class="select select-bordered select-sm" x-model="src.use">
                  <option value="linear">linear</option>
                  <option value="command">command</option>
                </select>
              </div>
              <div class="form-control">
                <label class="label py-1"><span class="label-text text-xs uppercase tracking-wide">Poll interval (ms)</span></label>
                <input class="input input-bordered input-sm" type="number" min="1000" x-model.number="src.pollIntervalMs">
              </div>
              <div class="form-control col-span-2">
                <label class="label py-1">
                  <span class="label-text text-xs uppercase tracking-wide">Plugin config (with)</span>
                  <span class="label-text-alt text-base-content/30">JSON</span>
                </label>
                <textarea class="textarea textarea-bordered form-textarea h-32" x-model="src.withJson" spellcheck="false"></textarea>
              </div>
            </div>
          </div>
        </template>
        <button class="btn btn-sm btn-dashed btn-block gap-2 border-dashed" @click="addSource()">${IC.plus} Add source</button>
      </div>

      <!-- HARNESSES -->
      <div x-show="!loadingConfig && configSection === 'harnesses'">
        <div class="mb-5">
          <h2 class="text-base font-semibold">Harnesses</h2>
          <p class="text-xs text-base-content/40 mt-1">Agent executors: codex, claude, pi, opencode, or custom.</p>
        </div>
        <template x-for="(h, i) in harnesses" :key="i">
          <div class="card card-compact bg-base-200 border border-base-300 mb-3">
            <div class="flex items-center gap-2 px-4 py-2.5 cursor-pointer select-none" @click.self="h.collapsed = !h.collapsed">
              <span :class="!h.collapsed && 'rotate-90'" class="text-base-content/40" @click="h.collapsed = !h.collapsed">${IC.chevron}</span>
              <input class="input input-xs bg-base-300 font-bold max-w-[160px]" x-model="h.key" placeholder="harness-name" @click.stop>
              <span class="badge badge-ghost badge-sm font-mono" x-text="h.use"></span>
              <div class="ml-auto" @click.stop>
                <button class="btn btn-xs btn-ghost text-error" @click="harnesses.splice(i,1)">${IC.trash}</button>
              </div>
            </div>
            <div x-show="!h.collapsed" class="px-4 pb-4 border-t border-base-300 pt-4 grid grid-cols-2 gap-3">
              <div class="form-control">
                <label class="label py-1"><span class="label-text text-xs uppercase tracking-wide">Type (use)</span></label>
                <select class="select select-bordered select-sm" x-model="h.use">
                  <option value="claude">claude</option>
                  <option value="codex">codex</option>
                  <option value="pi">pi</option>
                  <option value="opencode">opencode</option>
                </select>
              </div>
              <div class="form-control col-span-2">
                <label class="label py-1">
                  <span class="label-text text-xs uppercase tracking-wide">Advanced config (with)</span>
                  <span class="label-text-alt text-base-content/30">JSON, optional</span>
                </label>
                <textarea class="textarea textarea-bordered form-textarea h-24" x-model="h.withJson" spellcheck="false" placeholder="{}"></textarea>
              </div>
            </div>
          </div>
        </template>
        <button class="btn btn-sm btn-dashed btn-block gap-2 border-dashed" @click="addHarness()">${IC.plus} Add harness</button>
      </div>

      <!-- ACTIONS -->
      <div x-show="!loadingConfig && configSection === 'actions'">
        <div class="mb-5">
          <h2 class="text-base font-semibold">Actions</h2>
          <p class="text-xs text-base-content/40 mt-1">Reusable steps executed when a trigger fires.</p>
        </div>
        <template x-for="(a, i) in actions" :key="i">
          <div class="card card-compact bg-base-200 border border-base-300 mb-3">
            <div class="flex items-center gap-2 px-4 py-2.5 cursor-pointer select-none" @click.self="a.collapsed = !a.collapsed">
              <span :class="!a.collapsed && 'rotate-90'" class="text-base-content/40" @click="a.collapsed = !a.collapsed">${IC.chevron}</span>
              <input class="input input-xs bg-base-300 font-bold max-w-[160px]" x-model="a.key" placeholder="action-name" @click.stop>
              <span class="badge badge-ghost badge-sm font-mono" x-text="a.use"></span>
              <div class="ml-auto flex items-center gap-3" @click.stop>
                <label class="flex items-center gap-2 cursor-pointer">
                  <input type="checkbox" class="toggle toggle-xs toggle-primary" x-model="a.enabled">
                  <span class="text-xs text-base-content/40" x-text="a.enabled ? 'enabled' : 'disabled'"></span>
                </label>
                <button class="btn btn-xs btn-ghost text-error" @click="actions.splice(i,1)">${IC.trash}</button>
              </div>
            </div>
            <div x-show="!a.collapsed" class="px-4 pb-4 border-t border-base-300 pt-4">
              <div class="grid grid-cols-2 gap-3 mb-3">
                <div class="form-control">
                  <label class="label py-1"><span class="label-text text-xs uppercase tracking-wide">Type (use)</span></label>
                  <select class="select select-bordered select-sm" x-model="a.use">
                    <option value="launch">launch</option>
                    <option value="cleanup">cleanup</option>
                  </select>
                </div>
              </div>

              <!-- Launch -->
              <template x-if="a.use === 'launch'">
                <div class="grid grid-cols-2 gap-3 border-t border-base-300 pt-3">
                  <div class="form-control">
                    <label class="label py-1">
                      <span class="label-text text-xs uppercase tracking-wide">Harness <span class="text-error">*</span></span>
                    </label>
                    <select class="select select-bordered select-sm" x-model="a.launchHarness">
                      <template x-for="hk in harnesses.map(h => h.key).filter(Boolean)" :key="hk">
                        <option :value="hk" x-text="hk"></option>
                      </template>
                    </select>
                  </div>
                  <div class="form-control">
                    <label class="label py-1"><span class="label-text text-xs uppercase tracking-wide">Mode</span></label>
                    <select class="select select-bordered select-sm" x-model="a.launchMode">
                      <option value="interactive">interactive</option>
                      <option value="oneshot">oneshot</option>
                    </select>
                  </div>
                  <div class="form-control col-span-2">
                    <label class="label py-1"><span class="label-text text-xs uppercase tracking-wide">Model <span class="text-base-content/30">(optional)</span></span></label>
                    <input class="input input-bordered input-sm" x-model="a.launchModel" placeholder="e.g. claude-sonnet-4-6">
                  </div>
                  <div class="form-control col-span-2">
                    <label class="label py-1">
                      <span class="label-text text-xs uppercase tracking-wide">Prompt template <span class="text-base-content/30">(inline)</span></span>
                      <span class="label-text-alt text-base-content/30">{{item.id}}, {{item.title}}, {{item.description}}</span>
                    </label>
                    <textarea class="textarea textarea-bordered form-textarea h-28" x-model="a.launchPrompt" spellcheck="false"></textarea>
                  </div>
                  <div class="form-control col-span-2">
                    <label class="label py-1">
                      <span class="label-text text-xs uppercase tracking-wide">Prompt file <span class="text-base-content/30">(alternative to inline)</span></span>
                    </label>
                    <input class="input input-bordered input-sm" x-model="a.launchPromptFile" placeholder=".task-relay/prompts/implement.md">
                  </div>
                  <div class="form-control col-span-2">
                    <label class="label py-1">
                      <span class="label-text text-xs uppercase tracking-wide">Extra config (with)</span>
                      <span class="label-text-alt text-base-content/30">JSON, merged on top</span>
                    </label>
                    <textarea class="textarea textarea-bordered form-textarea h-20" x-model="a.launchExtraJson" spellcheck="false" placeholder="{}"></textarea>
                  </div>
                </div>
              </template>

              <!-- Cleanup -->
              <template x-if="a.use === 'cleanup'">
                <div class="border-t border-base-300 pt-3">
                  <div class="form-control max-w-xs">
                    <label class="label py-1"><span class="label-text text-xs uppercase tracking-wide">Active worker</span></label>
                    <select class="select select-bordered select-sm" x-model="a.cleanupActiveWorker">
                      <option value="stop">stop (default)</option>
                      <option value="skip">skip (keep running)</option>
                    </select>
                  </div>
                </div>
              </template>

              <!-- Fallback -->
              <template x-if="a.use !== 'launch' && a.use !== 'cleanup'">
                <div class="border-t border-base-300 pt-3">
                  <div class="form-control">
                    <label class="label py-1">
                      <span class="label-text text-xs uppercase tracking-wide">Config (with)</span>
                      <span class="label-text-alt text-base-content/30">JSON</span>
                    </label>
                    <textarea class="textarea textarea-bordered form-textarea h-32" x-model="a.withJson" spellcheck="false"></textarea>
                  </div>
                </div>
              </template>
            </div>
          </div>
        </template>
        <button class="btn btn-sm btn-dashed btn-block gap-2 border-dashed" @click="addAction()">${IC.plus} Add action</button>
      </div>

      <!-- TRIGGERS -->
      <div x-show="!loadingConfig && configSection === 'triggers'">
        <div class="mb-5">
          <h2 class="text-base font-semibold">Triggers</h2>
          <p class="text-xs text-base-content/40 mt-1">Rules that match work items from a source and dispatch actions.</p>
        </div>
        <template x-for="(t, i) in triggers" :key="i">
          <div class="card card-compact bg-base-200 border border-base-300 mb-3">
            <div class="flex items-center gap-2 px-4 py-2.5 cursor-pointer select-none" @click.self="t.collapsed = !t.collapsed">
              <span :class="!t.collapsed && 'rotate-90'" class="text-base-content/40" @click="t.collapsed = !t.collapsed">${IC.chevron}</span>
              <input class="input input-xs bg-base-300 font-bold max-w-[220px]" x-model="t.id" placeholder="trigger-id" @click.stop>
              <span class="badge badge-ghost badge-sm font-mono text-base-content/50" x-text="t.source"></span>
              <div class="ml-auto flex items-center gap-3" @click.stop>
                <label class="flex items-center gap-2 cursor-pointer">
                  <input type="checkbox" class="toggle toggle-xs toggle-primary" x-model="t.enabled">
                  <span class="text-xs text-base-content/40" x-text="t.enabled ? 'enabled' : 'disabled'"></span>
                </label>
                <button class="btn btn-xs btn-ghost text-error" @click="triggers.splice(i,1)">${IC.trash}</button>
              </div>
            </div>
            <div x-show="!t.collapsed" class="px-4 pb-4 border-t border-base-300 pt-4 grid grid-cols-2 gap-3">
              <div class="form-control">
                <label class="label py-1"><span class="label-text text-xs uppercase tracking-wide">Source <span class="text-error">*</span></span></label>
                <select class="select select-bordered select-sm" x-model="t.source">
                  <template x-for="sk in sources.map(s => s.key).filter(Boolean)" :key="sk">
                    <option :value="sk" x-text="sk"></option>
                  </template>
                </select>
              </div>
              <div class="form-control">
                <label class="label py-1"><span class="label-text text-xs uppercase tracking-wide">Fire policy</span></label>
                <select class="select select-bordered select-sm" x-model="t.firePolicy">
                  <option value="once-per-match">once-per-match</option>
                  <option value="once-per-item">once-per-item</option>
                  <option value="on-change">on-change</option>
                  <option value="every-poll">every-poll</option>
                </select>
              </div>
              <div class="form-control">
                <label class="label py-1"><span class="label-text text-xs uppercase tracking-wide">Max concurrent</span></label>
                <input class="input input-bordered input-sm" type="number" min="1" max="32" x-model.number="t.maxConcurrent" placeholder="inherit">
              </div>
              <div></div>
              <div class="form-control col-span-2">
                <label class="label py-1">
                  <span class="label-text text-xs uppercase tracking-wide">Actions <span class="text-error">*</span></span>
                  <span class="label-text-alt text-base-content/30">click to toggle</span>
                </label>
                <div class="flex flex-wrap gap-2">
                  <template x-for="ak in actions.map(a => a.key).filter(Boolean)" :key="ak">
                    <button type="button"
                      class="badge badge-md cursor-pointer border font-mono"
                      :class="t.actionRefs.includes(ak) ? 'badge-primary' : 'badge-ghost'"
                      @click="toggleRef(t, ak)" x-text="ak"></button>
                  </template>
                  <span class="text-xs text-base-content/30 self-center" x-show="actions.length === 0">No actions defined yet.</span>
                </div>
              </div>
              <div class="form-control col-span-2">
                <label class="label py-1">
                  <span class="label-text text-xs uppercase tracking-wide">Match rules</span>
                  <span class="label-text-alt text-base-content/30">JSON, source-specific</span>
                </label>
                <textarea class="textarea textarea-bordered form-textarea h-32" x-model="t.matchJson" spellcheck="false"></textarea>
              </div>
              <div class="form-control col-span-2">
                <label class="label py-1">
                  <span class="label-text text-xs uppercase tracking-wide">Worker targets</span>
                  <span class="label-text-alt text-base-content/30">JSON, optional (cleanup triggers)</span>
                </label>
                <textarea class="textarea textarea-bordered form-textarea h-20" x-model="t.targetsJson" spellcheck="false" placeholder='{"workers":{"sourceItem":"current","runs":"all"}}'></textarea>
              </div>
            </div>
          </div>
        </template>
        <button class="btn btn-sm btn-dashed btn-block gap-2 border-dashed" @click="addTrigger()">${IC.plus} Add trigger</button>
      </div>

      <!-- WORKSPACE -->
      <div x-show="!loadingConfig && configSection === 'workspace'">
        <div class="mb-5">
          <h2 class="text-base font-semibold">Workspace</h2>
          <p class="text-xs text-base-content/40 mt-1">How isolated workspaces are created for each worker.</p>
        </div>
        <div class="grid grid-cols-2 gap-3 max-w-2xl">
          <div class="form-control">
            <label class="label py-1"><span class="label-text text-xs uppercase tracking-wide">Adapter</span></label>
            <select class="select select-bordered select-sm" x-model="workspace.adapter">
              <option value="wt">wt (recommended)</option>
              <option value="git-worktree">git-worktree</option>
            </select>
          </div>
          <div class="form-control">
            <label class="label py-1"><span class="label-text text-xs uppercase tracking-wide">Directory</span></label>
            <input class="input input-bordered input-sm" x-model="workspace.directory" placeholder=".task-relay/workspaces">
          </div>
          <div class="form-control">
            <label class="label py-1"><span class="label-text text-xs uppercase tracking-wide">Base branch</span></label>
            <input class="input input-bordered input-sm" x-model="workspace.baseBranch" placeholder="main">
          </div>
          <div class="form-control">
            <label class="label py-1"><span class="label-text text-xs uppercase tracking-wide">Branch prefix</span></label>
            <input class="input input-bordered input-sm" x-model="workspace.branchPrefix" placeholder="relay">
          </div>
          <div class="form-control col-span-2">
            <label class="label py-1">
              <span class="label-text text-xs uppercase tracking-wide">Branch template</span>
              <span class="label-text-alt text-base-content/30">optional</span>
            </label>
            <input class="input input-bordered input-sm" x-model="workspace.branchTemplate" placeholder="{{prefix}}/{{item.id}}-{{item.title | slug}}">
          </div>
        </div>
      </div>

      <!-- EXECUTION -->
      <div x-show="!loadingConfig && configSection === 'execution'">
        <div class="mb-5">
          <h2 class="text-base font-semibold">Execution</h2>
          <p class="text-xs text-base-content/40 mt-1">Concurrency limits, retries, and how workers are launched.</p>
        </div>
        <div class="grid grid-cols-2 gap-3 max-w-2xl">
          <div class="form-control">
            <label class="label py-1"><span class="label-text text-xs uppercase tracking-wide">Max concurrent workers</span></label>
            <input class="input input-bordered input-sm" type="number" min="1" max="32" x-model.number="execution.maxConcurrent">
          </div>
          <div class="form-control">
            <label class="label py-1"><span class="label-text text-xs uppercase tracking-wide">Retries on failure</span></label>
            <input class="input input-bordered input-sm" type="number" min="0" max="10" x-model.number="execution.retries">
          </div>
          <div class="form-control">
            <label class="label py-1"><span class="label-text text-xs uppercase tracking-wide">Adapter</span></label>
            <select class="select select-bordered select-sm" x-model="execution.adapter">
              <option value="tmux">tmux</option>
              <option value="process">process</option>
            </select>
          </div>
          <div class="form-control">
            <label class="label py-1">
              <span class="label-text text-xs uppercase tracking-wide">tmux session name</span>
              <span class="label-text-alt text-base-content/30">optional</span>
            </label>
            <input class="input input-bordered input-sm" x-model="execution.tmuxSession" placeholder="task-relay-project">
          </div>
          <div class="form-control col-span-2">
            <label class="label py-1">
              <span class="label-text text-xs uppercase tracking-wide">tmux window name template</span>
              <span class="label-text-alt text-base-content/30">optional — leave blank for ticket ID only</span>
            </label>
            <input class="input input-bordered input-sm" x-model="execution.tmuxWindowName" placeholder="{{item.id}} {{item.title}}">
            <label class="label py-0.5">
              <span class="label-text-alt text-base-content/25">Variables: {{item.id}}, {{item.title}}, {{slug}}, {{item.description}}, {{branch}}</span>
            </label>
          </div>
        </div>
      </div>

      <!-- LOGGING -->
      <div x-show="!loadingConfig && configSection === 'logging'">
        <div class="mb-5">
          <h2 class="text-base font-semibold">Logging</h2>
          <p class="text-xs text-base-content/40 mt-1">Log verbosity and output formatting.</p>
        </div>
        <div class="grid grid-cols-2 gap-3 max-w-sm">
          <div class="form-control">
            <label class="label py-1"><span class="label-text text-xs uppercase tracking-wide">Level</span></label>
            <select class="select select-bordered select-sm" x-model="logging.level">
              <option value="trace">trace</option>
              <option value="debug">debug</option>
              <option value="info">info (default)</option>
              <option value="warn">warn</option>
              <option value="error">error</option>
              <option value="silent">silent</option>
            </select>
          </div>
          <div class="form-control">
            <label class="label py-1"><span class="label-text text-xs uppercase tracking-wide">Pretty output</span></label>
            <label class="flex items-center gap-2 cursor-pointer mt-2">
              <input type="checkbox" class="toggle toggle-sm toggle-primary" x-model="logging.pretty">
              <span class="text-sm text-base-content/50" x-text="logging.pretty ? 'enabled' : 'disabled'"></span>
            </label>
          </div>
        </div>
      </div>

      <!-- RAW YAML -->
      <div x-show="!loadingConfig && configSection === 'yaml'">
        <div class="mb-5">
          <h2 class="text-base font-semibold">Raw YAML</h2>
          <p class="text-xs text-base-content/40 mt-1">Direct file edit. Used by agents and for advanced config. Validated before saving.</p>
        </div>
        <textarea class="textarea textarea-bordered form-textarea w-full h-[60vh]" x-model="yamlContent" spellcheck="false" autocomplete="off"></textarea>
      </div>

    </div><!-- /scroll -->

    <!-- Save bar -->
    <div class="shrink-0 bg-base-200 border-t border-base-300 px-5 py-3 flex items-center gap-3" x-show="!loadingConfig">
      <button class="btn btn-primary btn-sm gap-2" :disabled="saving" @click="save()">
        ${IC.save}
        <span x-text="saving ? 'Saving…' : 'Save'"></span>
      </button>
      <template x-if="feedback && feedback.type === 'success'">
        <div class="flex items-center gap-1.5 text-success text-sm">
          ${IC.check} <span x-text="feedback.message"></span>
        </div>
      </template>
      <template x-if="feedback && feedback.type === 'error'">
        <div class="text-error text-xs">
          <ul class="list-disc list-inside" x-html="(feedback.errors || []).map(function(e){return '<li>'+e+'</li>';}).join('')"></ul>
        </div>
      </template>
    </div>
  </div>
</div>

<!-- Cleanup dialog -->
<dialog class="modal" :class="cleanupTarget && 'modal-open'">
  <div class="modal-box">
    <h3 class="font-bold text-lg mb-2">Stop &amp; Clean worker</h3>
    <p class="text-sm text-base-content/60 mb-5" x-text="cleanupTarget ? 'Stop worker and remove workspace for ' + cleanupTarget.itemId + ': ' + cleanupTarget.title + '? This cannot be undone.' : ''"></p>
    <div class="modal-action mt-0">
      <button class="btn btn-sm" @click="cleanupTarget = null">Cancel</button>
      <button class="btn btn-sm btn-error gap-1.5" :disabled="cleaningUp" @click="doCleanup()">
        ${IC.stop}
        <span x-text="cleaningUp ? 'Stopping…' : 'Stop & Clean'"></span>
      </button>
    </div>
  </div>
  <div class="modal-backdrop bg-black/50" @click="cleanupTarget = null"></div>
</dialog>

<!-- ─── Worker control modal ─── -->
<dialog class="modal" :class="controlTarget && 'modal-open'">
  <div class="modal-box max-w-2xl" x-show="controlTarget">
    <h3 class="font-bold text-sm mb-1" x-text="controlKind === 'send' ? 'Send a prompt to the worker' : 'Open a pane beside the worker'"></h3>
    <p class="text-xs text-base-content/50 mb-4">
      <span class="text-primary font-medium" x-text="controlTarget && controlTarget.itemId"></span>
      <span x-text="controlTarget && (' · ' + controlTarget.workerId)"></span>
    </p>

    <div x-show="controlKind === 'send'" class="space-y-2">
      <textarea class="textarea textarea-bordered w-full form-textarea h-40" x-model="controlText"
        placeholder="Text pasted into the worker's live session"></textarea>
      <label class="label cursor-pointer justify-start gap-2 py-0">
        <input type="checkbox" class="checkbox checkbox-xs" x-model="controlSubmit">
        <span class="label-text text-xs">Press Enter after pasting</span>
      </label>
    </div>

    <div x-show="controlKind === 'exec'" class="space-y-2">
      <div class="grid grid-cols-3 gap-2">
        <label class="form-control col-span-2">
          <span class="label-text text-xs">Command</span>
          <input class="input input-sm input-bordered" x-model="controlCommand" placeholder="npm">
        </label>
        <label class="form-control">
          <span class="label-text text-xs">Open as</span>
          <select class="select select-sm select-bordered" x-model="controlOpen">
            <option value="pane">pane</option>
            <option value="window">window</option>
          </select>
        </label>
      </div>
      <label class="form-control">
        <span class="label-text text-xs">Arguments (one per line)</span>
        <textarea class="textarea textarea-bordered w-full form-textarea h-20" x-model="controlArgs" placeholder="run&#10;dev"></textarea>
      </label>
      <label class="form-control">
        <span class="label-text text-xs">Name (optional)</span>
        <input class="input input-sm input-bordered" x-model="controlName" placeholder="dev">
      </label>
      <p class="text-xs text-base-content/40">Runs in the worker's workspace. Output stays visible after it exits.</p>
    </div>

    <div class="alert alert-error py-2 mt-3" x-show="controlError">
      ${IC.warning}<span class="text-xs" x-text="controlError"></span>
    </div>

    <div class="modal-action">
      <button class="btn btn-sm btn-ghost" @click="controlTarget = null">Cancel</button>
      <button class="btn btn-sm btn-primary gap-1.5" :disabled="controlBusy" @click="doControl()">
        <span x-text="controlBusy ? 'Working…' : (controlKind === 'send' ? 'Send' : 'Open')"></span>
      </button>
    </div>
  </div>
  <div class="modal-backdrop bg-black/50" @click="controlTarget = null"></div>
</dialog>

<!-- ─── Workflow test output ─── -->
<dialog class="modal" :class="testOutput && 'modal-open'">
  <div class="modal-box max-w-4xl" x-show="testOutput">
    <h3 class="font-bold text-sm mb-3">Dry run — <span class="text-primary" x-text="testOutputFor"></span></h3>
    <pre class="bg-base-300 rounded p-3 text-xs overflow-auto max-h-96 whitespace-pre-wrap" x-text="testOutput"></pre>
    <div class="modal-action">
      <button class="btn btn-sm btn-ghost" @click="testOutput = null">Close</button>
    </div>
  </div>
  <div class="modal-backdrop bg-black/50" @click="testOutput = null"></div>
</dialog>

<!-- ─── Live event feed ─── -->
<div class="border-t border-base-300 bg-base-200 shrink-0" :class="feedOpen ? '' : 'h-auto'">
  <button class="w-full px-4 py-1.5 flex items-center gap-2 text-xs text-base-content/50 hover:text-base-content" @click="feedOpen = !feedOpen">
    ${IC.feed}
    <span>Live events</span>
    <span class="badge badge-xs" :class="feedConnected ? 'badge-success' : 'badge-ghost'" x-text="feedConnected ? 'streaming' : 'offline'"></span>
    <div class="flex-1"></div>
    <span class="text-base-content/30" x-text="events.length + ' events'"></span>
    <span :class="feedOpen && 'rotate-90'">${IC.chevron}</span>
  </button>
  <div x-show="feedOpen" class="h-48 overflow-auto px-4 pb-2 font-mono text-xs space-y-0.5">
    <template x-if="events.length === 0">
      <div class="text-base-content/30 py-4">Waiting for events…</div>
    </template>
    <template x-for="(e, i) in events" :key="i">
      <div class="flex gap-2">
        <span class="text-base-content/30 shrink-0" x-text="fmtTime(e.time)"></span>
        <span class="shrink-0 w-14" :class="e.level >= 50 ? 'text-error' : e.level >= 40 ? 'text-warning' : 'text-base-content/40'" x-text="levelName(e.level)"></span>
        <span class="text-primary shrink-0 w-20 truncate" x-text="e.task || ''"></span>
        <span class="text-base-content/80 break-all" x-text="e.msg || e.event || ''"></span>
      </div>
    </template>
  </div>
</div>

<script>
function relay() {
  return {
    daemon: 'checking', activeRuns: '—', totalRuns: '—',
    mainTab: 'workers', runs: [], loadingRuns: true,
    allStatuses: ['claimed','provisioning','launching','running','failed','stopped','succeeded'],
    hiddenStatuses: ['stopped','succeeded'],
    configSection: 'project', loadingConfig: true, saving: false,
    feedback: null, externalChanged: false, lastMtime: 0, configPath: '',
    configSections: [
      {id:'project',label:'Project'},{id:'sources',label:'Sources'},
      {id:'harnesses',label:'Harnesses'},{id:'actions',label:'Actions'},
      {id:'triggers',label:'Triggers'},{id:'workspace',label:'Workspace'},
      {id:'execution',label:'Execution'},{id:'logging',label:'Logging'},
    ],
    project: {name:''},
    sources: [], harnesses: [], actions: [], triggers: [],
    workspace: {adapter:'wt',directory:'.task-relay/workspaces',baseBranch:'main',branchPrefix:'relay',branchTemplate:''},
    execution: {maxConcurrent:2,retries:2,adapter:'tmux',tmuxSession:'',tmuxWindowName:''},
    logging: {level:'info',pretty:true},
    yamlContent: '',
    /** Config keys the form does not model, preserved verbatim across a save. */
    passthrough: {},
    cleanupTarget: null, cleaningUp: false,
    workflows: [], loadingWorkflows: true, testing: null, testOutput: null, testOutputFor: '',
    pluginsInstalled: [], pluginRefs: [], pluginDirectory: '', loadingPlugins: true,
    controlTarget: null, controlKind: 'send', controlBusy: false, controlError: '',
    controlText: '', controlSubmit: true, controlCommand: '', controlArgs: '', controlName: '', controlOpen: 'pane',
    events: [], feedOpen: false, feedConnected: false,

    async boot() {
      // Plugins load at boot so the tab badge can warn about a missing plugin
      // before anyone thinks to look at that tab.
      await Promise.all([this.loadStatus(), this.loadRuns(), this.loadPlugins()]);
      this.openEventStream();
      setInterval(() => this.loadStatus(), 5000);
      setInterval(() => { if (this.mainTab === 'workers') this.loadRuns(); }, 5000);
      setInterval(() => { if (this.mainTab === 'workflows') this.loadWorkflows(); }, 5000);
      setInterval(() => this.checkMtime(), 10000);
    },

    // ── Live events ────────────────────────────────────────────────────────
    openEventStream() {
      var self = this;
      var stream = new EventSource('/api/events');
      stream.onopen = function(){ self.feedConnected = true; };
      stream.onerror = function(){ self.feedConnected = false; };
      stream.onmessage = function(message) {
        try { var parsed = JSON.parse(message.data); } catch (e) { return; }
        // Newest first, and bounded: this panel is a tail, not an archive.
        self.events.unshift(parsed);
        if (self.events.length > 300) self.events.length = 300;
        // A lifecycle event means the tables on screen are already stale.
        if (self.mainTab === 'workers') self.loadRuns();
        if (self.mainTab === 'workflows') self.loadWorkflows();
      };
    },
    levelName(level) { return level >= 50 ? 'error' : level >= 40 ? 'warn' : level >= 30 ? 'info' : 'debug'; },
    fmtTime(iso) { if (!iso) return '--:--:--'; var d = new Date(iso), z = function(n){return String(n).padStart(2,'0');}; return z(d.getHours())+':'+z(d.getMinutes())+':'+z(d.getSeconds()); },

    // ── Workflows ──────────────────────────────────────────────────────────
    async switchToWorkflows() {
      this.mainTab = 'workflows';
      if (this.loadingWorkflows) await this.loadWorkflows();
    },
    async loadWorkflows() {
      try {
        var d = await fetch('/api/workflows').then(function(r){return r.json();});
        this.workflows = d.workflows || [];
      } catch(e) {}
      this.loadingWorkflows = false;
    },
    needLabel(need) {
      if (typeof need === 'string') return need.indexOf('.') > 0 ? need : need + '.Succeeded';
      return need.job + '.' + (need.status ? need.status.charAt(0).toUpperCase() + need.status.slice(1) : 'Succeeded');
    },
    jobState(run, jobId) { return (run.jobs && run.jobs[jobId]) || {status:'pending',attempts:0}; },
    jobBadgeClass(status) {
      return {
        'badge-info': status === 'started',
        'badge-success': status === 'succeeded',
        'badge-error': status === 'failed',
        'badge-warning': status === 'omitted',
        'badge-ghost': status === 'pending' || status === 'skipped',
      };
    },
    jobTitle(state) {
      var parts = [];
      if (state.message) parts.push(state.message);
      if (state.error) parts.push(state.error);
      if (state.workerId) parts.push('worker ' + state.workerId);
      if (state.outputs) parts.push('outputs ' + JSON.stringify(state.outputs));
      if (state.attempts) parts.push(state.attempts + ' attempt(s)');
      return parts.join(' · ') || 'not started';
    },
    /** Jobs that have not settled, with what each is still waiting for. */
    blockedJobs(wf, run) {
      var self = this;
      return wf.jobs.filter(function(job){ return self.jobState(run, job.id).status === 'pending'; }).map(function(job){
        var unmet = job.needs.map(function(need){ return self.needLabel(need); }).filter(function(label){
          var target = label.split('.')[0];
          var wanted = label.split('.')[1].toLowerCase();
          var status = self.jobState(run, target).status;
          return wanted === 'succeeded' ? (status !== 'succeeded' && status !== 'skipped') : status !== wanted;
        });
        return job.id + (unmet.length ? ' ← ' + unmet.join(', ') : '');
      });
    },
    async testWorkflow(id) {
      this.testing = id;
      try {
        var res = await fetch('/api/workflows/'+encodeURIComponent(id)+'/test',{method:'POST'});
        var data = await res.json();
        this.testOutputFor = id;
        this.testOutput = data.ok ? (data.output || '(no output)') : ('Failed: ' + (data.error || 'unknown error'));
      } catch(e) { this.testOutputFor = id; this.testOutput = 'Request failed: ' + e.message; }
      this.testing = null;
    },

    // ── Plugins ────────────────────────────────────────────────────────────
    async switchToPlugins() {
      this.mainTab = 'plugins';
      if (this.loadingPlugins) await this.loadPlugins();
    },
    async loadPlugins() {
      try {
        var d = await fetch('/api/plugins').then(function(r){return r.json();});
        this.pluginsInstalled = d.installed || [];
        this.pluginRefs = d.referenced || [];
        this.pluginDirectory = d.directory || '';
      } catch(e) {}
      this.loadingPlugins = false;
    },
    pluginProblems() { return this.pluginRefs.filter(function(r){ return r.state !== 'ok' && r.state !== 'local'; }).length; },
    pluginBadgeClass(state) {
      return {
        'badge-success': state === 'ok',
        'badge-ghost': state === 'local',
        'badge-error': state === 'not-installed' || state === 'missing-file',
        'badge-warning': state === 'integrity-mismatch',
      };
    },
    pluginStateLabel(ref) {
      if (ref.state === 'ok') return 'installed ' + ref.version;
      if (ref.state === 'local') return 'local module';
      if (ref.state === 'not-installed') return 'not installed';
      if (ref.state === 'missing-file') return 'missing on disk';
      return 'changed since install';
    },

    // ── Worker control ─────────────────────────────────────────────────────
    canControl(run) {
      return ['claimed','provisioning','launching','running'].indexOf(run.status) >= 0
        && !!(run.worker && run.worker.metadata && run.worker.metadata.tmux);
    },
    openControl(run, kind) {
      this.controlTarget = {workerId: run.worker.id, itemId: run.item.id};
      this.controlKind = kind; this.controlError = ''; this.controlBusy = false;
      this.controlText = ''; this.controlSubmit = true;
      this.controlCommand = ''; this.controlArgs = ''; this.controlName = ''; this.controlOpen = 'pane';
    },
    async doControl() {
      if (!this.controlTarget) return;
      this.controlBusy = true; this.controlError = '';
      var body = this.controlKind === 'send'
        ? {text: this.controlText, submit: this.controlSubmit}
        : {
            command: this.controlCommand,
            args: this.controlArgs.split('\\n').map(function(a){return a.trim();}).filter(Boolean),
            open: this.controlOpen,
            name: this.controlName || undefined,
          };
      try {
        var res = await fetch('/api/workers/'+encodeURIComponent(this.controlTarget.workerId)+'/'+this.controlKind,
          {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
        var data = await res.json();
        if (data.ok) { this.controlTarget = null; await this.loadRuns(); }
        else this.controlError = data.error || 'Unknown error';
      } catch(e) { this.controlError = e.message; }
      this.controlBusy = false;
    },
    async switchToConfig() {
      this.mainTab = 'config';
      if (this.loadingConfig) await this.loadConfig();
    },
    async loadStatus() {
      try {
        var d = await fetch('/api/status').then(function(r){return r.json();});
        this.daemon = d.daemon; this.activeRuns = d.activeRuns; this.totalRuns = d.totalRuns;
      } catch(e) {}
    },
    async loadRuns() {
      try { this.runs = await fetch('/api/runs').then(function(r){return r.json();}); } catch(e) {}
      this.loadingRuns = false;
    },
    async loadConfig() {
      this.loadingConfig = true;
      try {
        var d = await fetch('/api/config/json').then(function(r){return r.json();});
        this.configPath = d.path || '';
        this.populateForm(d.config);
        var mt = await fetch('/api/config/mtime').then(function(r){return r.json();});
        this.lastMtime = mt.mtime || 0;
        this.externalChanged = false;
        var yd = await fetch('/api/config').then(function(r){return r.json();});
        this.yamlContent = yd.yaml || '';
      } catch(e) {}
      this.loadingConfig = false;
    },
    async reloadConfig() {
      this.externalChanged = false; this.feedback = null;
      await this.loadConfig();
    },
    async checkMtime() {
      if (this.mainTab !== 'config') return;
      try {
        var d = await fetch('/api/config/mtime').then(function(r){return r.json();});
        if (this.lastMtime && d.mtime && d.mtime !== this.lastMtime) this.externalChanged = true;
      } catch(e) {}
    },
    async save() {
      this.saving = true; this.feedback = null;
      try {
        if (this.configSection === 'yaml') await this.saveYaml();
        else await this.saveForm();
      } finally { this.saving = false; }
    },
    async saveForm() {
      var config;
      try { config = this.buildConfig(); } catch(e) { this.feedback = {type:'error',errors:[e.message]}; return; }
      var res = await fetch('/api/config/json',{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify({config})});
      var data = await res.json();
      if (data.ok) {
        this.feedback = {type:'success',message:'Saved. Restart the daemon to apply.'};
        var mt = await fetch('/api/config/mtime').then(function(r){return r.json();});
        this.lastMtime = mt.mtime || 0; this.externalChanged = false;
        var yd = await fetch('/api/config').then(function(r){return r.json();});
        this.yamlContent = yd.yaml || '';
      } else {
        this.feedback = {type:'error',errors:data.errors||[data.error||'Unknown error']};
      }
    },
    async saveYaml() {
      var res = await fetch('/api/config',{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify({yaml:this.yamlContent})});
      var data = await res.json();
      if (data.ok) {
        this.feedback = {type:'success',message:'Saved. Restart the daemon to apply.'};
        var mt = await fetch('/api/config/mtime').then(function(r){return r.json();});
        this.lastMtime = mt.mtime || 0; this.externalChanged = false;
        var jd = await fetch('/api/config/json').then(function(r){return r.json();});
        this.populateForm(jd.config);
      } else {
        this.feedback = {type:'error',errors:data.errors||[data.error||'Unknown error']};
      }
    },
    buildConfig() {
      var sources = {};
      for (var i=0;i<this.sources.length;i++) {
        var s=this.sources[i]; if (!s.key) continue;
        var sw={}; try{sw=JSON.parse(s.withJson||'{}');}catch(e){throw new Error('Source "'+s.key+'" — invalid JSON: '+e.message);}
        sources[s.key]={use:s.use,enabled:s.enabled,pollIntervalMs:Number(s.pollIntervalMs)};
        if (Object.keys(sw).length>0) sources[s.key].with=sw;
      }
      var harnesses = {};
      for (var i=0;i<this.harnesses.length;i++) {
        var h=this.harnesses[i]; if (!h.key) continue;
        var hw={}; try{hw=JSON.parse(h.withJson||'{}');}catch(e){throw new Error('Harness "'+h.key+'" — invalid JSON: '+e.message);}
        harnesses[h.key]={use:h.use}; if (Object.keys(hw).length>0) harnesses[h.key].with=hw;
      }
      var actions = {};
      for (var i=0;i<this.actions.length;i++) {
        var a=this.actions[i]; if (!a.key) continue;
        var aw={};
        if (a.use==='launch') {
          aw={harness:a.launchHarness,mode:a.launchMode};
          if (a.launchPrompt) aw.prompt=a.launchPrompt;
          if (a.launchPromptFile) aw.promptFile=a.launchPromptFile;
          if (a.launchModel) aw.model=a.launchModel;
          var extra={}; try{extra=JSON.parse(a.launchExtraJson||'{}');}catch(e){throw new Error('Action "'+a.key+'" extra JSON: '+e.message);}
          Object.assign(aw,extra);
        } else if (a.use==='cleanup') {
          aw={activeWorker:a.cleanupActiveWorker||'stop'};
        } else {
          try{aw=JSON.parse(a.withJson||'{}');}catch(e){throw new Error('Action "'+a.key+'" — invalid JSON: '+e.message);}
        }
        actions[a.key]={use:a.use,enabled:a.enabled};
        if (Object.keys(aw).length>0) actions[a.key].with=aw;
      }
      var triggers = [];
      for (var i=0;i<this.triggers.length;i++) {
        var t=this.triggers[i]; if (!t.id) continue;
        var match={}; try{match=JSON.parse(t.matchJson||'{}');}catch(e){throw new Error('Trigger "'+t.id+'" match JSON: '+e.message);}
        var trig={id:t.id,source:t.source,enabled:t.enabled,match:match,actions:t.actionRefs.slice(),fire:{policy:t.firePolicy}};
        if (t.maxConcurrent) trig.maxConcurrent=Number(t.maxConcurrent);
        if (t.targetsJson&&t.targetsJson.trim()){try{trig.targets=JSON.parse(t.targetsJson);}catch(e){throw new Error('Trigger "'+t.id+'" targets JSON: '+e.message);}}
        triggers.push(trig);
      }
      var ws={adapter:this.workspace.adapter,directory:this.workspace.directory,baseBranch:this.workspace.baseBranch,branchPrefix:this.workspace.branchPrefix};
      if (this.workspace.branchTemplate) ws.branchTemplate=this.workspace.branchTemplate;
      var ex={maxConcurrent:Number(this.execution.maxConcurrent),retries:Number(this.execution.retries),adapter:this.execution.adapter};
      if (this.execution.tmuxSession) ex.tmuxSession=this.execution.tmuxSession;
      if (this.execution.tmuxWindowName) ex.tmuxWindowName=this.execution.tmuxWindowName;
      var proj={}; if (this.project.name) proj.name=this.project.name;
      // Anything this form does not model is carried through untouched. Without
      // this, saving from the form would silently delete blocks it cannot edit.
      var built={version:2,project:proj,sources,harnesses,actions,triggers,workspace:ws,execution:ex,logging:{level:this.logging.level,pretty:this.logging.pretty}};
      for (var key in this.passthrough) if (Object.prototype.hasOwnProperty.call(this.passthrough,key)) built[key]=this.passthrough[key];
      return built;
    },
    populateForm(config) {
      var c=config||{};
      var modelled={version:1,project:1,sources:1,harnesses:1,actions:1,triggers:1,workspace:1,execution:1,logging:1};
      this.passthrough={};
      for (var key in c) if (Object.prototype.hasOwnProperty.call(c,key) && !modelled[key]) this.passthrough[key]=c[key];
      this.project={name:(c.project&&c.project.name)||''};
      this.sources=Object.entries(c.sources||{}).map(function(pair){
        var key=pair[0],s=pair[1];
        return {key,use:s.use,enabled:s.enabled!==false,pollIntervalMs:s.pollIntervalMs||30000,withJson:s.with?JSON.stringify(s.with,null,2):'{}',collapsed:true};
      });
      this.harnesses=Object.entries(c.harnesses||{}).map(function(pair){
        var key=pair[0],h=pair[1];
        return {key,use:h.use,withJson:h.with?JSON.stringify(h.with,null,2):'{}',collapsed:true};
      });
      this.actions=Object.entries(c.actions||{}).map(function(pair){
        var key=pair[0],a=pair[1],w=a.with||{};
        var base={key,use:a.use,enabled:a.enabled!==false,withJson:'{}',collapsed:true};
        if (a.use==='launch') {
          var extra=Object.assign({},w);
          delete extra.harness;delete extra.mode;delete extra.model;delete extra.prompt;delete extra.promptFile;
          base.launchHarness=w.harness||'';base.launchMode=w.mode||'interactive';
          base.launchModel=w.model||'';base.launchPrompt=w.prompt||'';
          base.launchPromptFile=w.promptFile||'';
          base.launchExtraJson=Object.keys(extra).length?JSON.stringify(extra,null,2):'{}';
        } else if (a.use==='cleanup') {
          base.cleanupActiveWorker=w.activeWorker||'stop';
        } else {
          base.withJson=Object.keys(w).length?JSON.stringify(w,null,2):'{}';
        }
        return base;
      });
      this.triggers=(c.triggers||[]).map(function(t){
        var refs=(t.actions||[]).filter(function(a){return typeof a==='string';});
        return {id:t.id,source:t.source,enabled:t.enabled!==false,matchJson:t.match&&Object.keys(t.match).length?JSON.stringify(t.match,null,2):'{}',actionRefs:refs,firePolicy:(t.fire&&t.fire.policy)||'once-per-match',maxConcurrent:t.maxConcurrent||'',targetsJson:t.targets?JSON.stringify(t.targets,null,2):'',collapsed:true};
      });
      var ws=c.workspace||{};
      this.workspace={adapter:ws.adapter||'wt',directory:ws.directory||'.task-relay/workspaces',baseBranch:ws.baseBranch||'main',branchPrefix:ws.branchPrefix||'relay',branchTemplate:ws.branchTemplate||''};
      var ex=c.execution||{};
      this.execution={maxConcurrent:ex.maxConcurrent||2,retries:ex.retries||2,adapter:ex.adapter||'tmux',tmuxSession:ex.tmuxSession||'',tmuxWindowName:ex.tmuxWindowName||''};
      var log=c.logging||{};
      this.logging={level:log.level||'info',pretty:log.pretty!==false};
    },
    addSource(){this.sources.push({key:'',use:'linear',enabled:true,pollIntervalMs:30000,withJson:'{}',collapsed:false});},
    addHarness(){this.harnesses.push({key:'',use:'claude',withJson:'{}',collapsed:false});},
    addAction(){this.actions.push({key:'',use:'launch',enabled:true,withJson:'{}',launchHarness:this.harnesses.length?this.harnesses[0].key:'',launchMode:'interactive',launchModel:'',launchPrompt:'Implement {{item.id}}: {{item.title}}\\n\\n{{item.description}}',launchPromptFile:'',launchExtraJson:'{}',collapsed:false});},
    addTrigger(){this.triggers.push({id:'',source:this.sources.length?this.sources[0].key:'',enabled:true,matchJson:'{}',actionRefs:[],firePolicy:'once-per-match',maxConcurrent:'',targetsJson:'',collapsed:false});},
    toggleRef(trigger,key){var idx=trigger.actionRefs.indexOf(key);if(idx>=0)trigger.actionRefs.splice(idx,1);else trigger.actionRefs.push(key);},
    filteredRuns(){return this.runs.filter((r) => this.hiddenStatuses.indexOf(r.status) < 0);},
    toggleStatus(s){var idx=this.hiddenStatuses.indexOf(s);if(idx>=0)this.hiddenStatuses.splice(idx,1);else this.hiddenStatuses.push(s);},
    statusBadgeClass(s){return {'badge-info':s==='running','badge-warning':['claimed','provisioning','launching'].indexOf(s)>=0,'badge-error':s==='failed','badge-ghost':s==='stopped','badge-success':s==='succeeded'};},
    fmtDate(iso){if(!iso)return '—';var d=new Date(iso),z=function(n){return String(n).padStart(2,'0');};return z(d.getMonth()+1)+'/'+z(d.getDate())+' '+z(d.getHours())+':'+z(d.getMinutes());},
    shortPath(p){if(!p)return '—';return p.split('/').slice(-2).join('/');},
    canClean(run){return ['claimed','provisioning','launching','running'].indexOf(run.status)>=0||(run.workspace&&!run.workspaceCleanedAt);},
    openCleanup(run){this.cleanupTarget={runId:run.id,itemId:run.item.id,title:run.item.title};},
    async doCleanup(){
      if(!this.cleanupTarget)return;
      this.cleaningUp=true;
      try{
        var res=await fetch('/api/runs/'+encodeURIComponent(this.cleanupTarget.runId)+'/cleanup',{method:'POST'});
        var data=await res.json();
        this.cleanupTarget=null;
        if(!data.ok)alert('Cleanup failed: '+(data.error||'unknown error'));
        await this.loadRuns();await this.loadStatus();
      }catch(e){alert('Request failed: '+e.message);}
      this.cleaningUp=false;
    },
  };
}
</script>
</body>
</html>`;
}
