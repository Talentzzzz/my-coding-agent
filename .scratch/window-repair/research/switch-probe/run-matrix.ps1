# Ticket 02's switch matrix.
#
# Each variant launches the *real* shell through the probe controller (which applies the switches
# before loading `packages/desktop/main.cjs`), waits for it to boot, measures the window, and exits.
# Nothing here edits production code: the question is which of the uncommitted 12 lines may be
# deleted, and a test that measured its own edit could not answer it.
#
#   pwsh -File .scratch/window-repair/research/switch-probe/run-matrix.ps1 [-ViaArgv]
param([switch]$ViaArgv)
$ErrorActionPreference = 'Continue'

$root = Resolve-Path (Join-Path $PSScriptRoot '..\..\..\..')
$electron = Join-Path $root 'packages\desktop\node_modules\electron\dist\electron.exe'
$probe = $PSScriptRoot
$logs = Join-Path $probe 'logs'
New-Item -ItemType Directory -Force $logs | Out-Null
Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue

# The GPU is the point of every variant, so the ones that would otherwise fall back to WARP ask for
# D3D11 explicitly; `no-sandbox` is the one switch the ticket's main question is a *removal* test for.
$gpu = 'use-angle=d3d11,ignore-gpu-blocklist'

$matrix = @(
	@{ name = '01-nosandbox-only';           switches = "no-sandbox,$gpu";                              software = $false },
	@{ name = '02-nosandbox-inprocessgpu';   switches = "no-sandbox,in-process-gpu,$gpu";              software = $false },
	@{ name = '03-nosandbox-disableha';      switches = "no-sandbox,$gpu";                              software = $true  },
	@{ name = '04-full-three';               switches = "no-sandbox,in-process-gpu,$gpu";              software = $true  },
	@{ name = '05-inprocessgpu-only';        switches = "in-process-gpu,$gpu";                          software = $false },
	@{ name = '06-nosandbox-noshadercache';  switches = "no-sandbox,disable-gpu-shader-disk-cache,$gpu"; software = $false }
)

foreach ($v in $matrix) {
	$log = Join-Path $logs "$($v.name).log"
	Remove-Item $log -ErrorAction SilentlyContinue
	$env:PROBE_LOG = $log
	$env:PROBE_SWITCHES = $v.switches
	$env:PROBE_SOFTWARE = if ($v.software) { '1' } else { '0' }
	$env:PROBE_MEASURE = '1'
	$env:PROBE_SETTLE_MS = '10000'
	$env:PROBE_TIMEOUT_MS = '45000'
	$env:PROBE_VIA_ARGV = if ($ViaArgv) { '1' } else { '0' }
	Write-Host "=== $($v.name)  switches=[$($v.switches)]  software=$($v.software)  viaArgv=$ViaArgv"
	# A switch passed the way a user types it goes on the real command line, after the app path.
	$arguments = if ($ViaArgv) { "`"$probe`" --$($v.switches -replace ',', ' --')" } else { "`"$probe`"" }
	$p = Start-Process -FilePath $electron -ArgumentList $arguments -PassThru -NoNewWindow
	if (-not $p.WaitForExit(60000)) { Write-Host '    (did not exit; killing)'; $p.Kill() }
	Start-Sleep -Milliseconds 1500
	# The whole verdict is in the log, so print it as it lands rather than making a second pass.
	if (Test-Path $log) { Get-Content $log | ForEach-Object { "    $_" } }
}
Remove-Item Env:PROBE_LOG, Env:PROBE_SWITCHES, Env:PROBE_SOFTWARE, Env:PROBE_MEASURE, Env:PROBE_SETTLE_MS, Env:PROBE_TIMEOUT_MS, Env:PROBE_VIA_ARGV -ErrorAction SilentlyContinue
Write-Host 'matrix done'
