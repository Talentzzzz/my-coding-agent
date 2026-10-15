# Does a GPU process exist at all on this machine, and does it die?
#
# `app.getAppMetrics()` reporting no GPU entry is weak evidence on its own - it could mean the process
# was never started, or that Electron stopped tracking it. This samples the operating system's own
# process list instead, every 300 ms, so a GPU process that appears and dies between two samples
# leaves at least one sighting behind. The crashing configuration from 2026-10-13 was the plain
# browser command line, so these runs pass switches the way a user would.
#
#   pwsh -File .scratch/window-repair/research/switch-probe/gpu-sightings.ps1
$ErrorActionPreference = 'Continue'

$root = Resolve-Path (Join-Path $PSScriptRoot '..\..\..\..')
$electron = Join-Path $root 'packages\desktop\node_modules\electron\dist\electron.exe'
$probe = $PSScriptRoot
Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue

$runs = @(
	@{ name = 'A-gpu-enabled';            args = '--use-angle=d3d11 --ignore-gpu-blocklist' },
	@{ name = 'B-gpu-enabled-nosandbox';  args = '--no-sandbox --use-angle=d3d11 --ignore-gpu-blocklist' },
	@{ name = 'C-plain';                  args = '' }
)

foreach ($run in $runs) {
	Write-Host "=== $($run.name)  args=[$($run.args)]"
	$env:PROBE_LOG = Join-Path $probe "logs\sightings-$($run.name).log"
	$env:PROBE_SWITCHES = ''
	$env:PROBE_SOFTWARE = '0'
	$env:PROBE_MEASURE = '0'
	$env:PROBE_SETTLE_MS = '14000'
	$env:PROBE_TIMEOUT_MS = '40000'
	$env:PROBE_VIA_ARGV = '0'
	$p = Start-Process -FilePath $electron -ArgumentList "`"$probe`" $($run.args)" -PassThru -NoNewWindow
	$sightings = @{}
	for ($i = 0; $i -lt 70; $i++) {
		foreach ($child in (Get-CimInstance Win32_Process -Filter "Name='electron.exe'" -ErrorAction SilentlyContinue)) {
			$type = if ($child.CommandLine -match '--type=([a-zA-Z-]+)') { $Matches[1] } else { 'browser' }
			if (-not $sightings.ContainsKey($type)) { $sightings[$type] = 0 }
			$sightings[$type]++
		}
		Start-Sleep -Milliseconds 300
	}
	if (-not $p.HasExited) { $p.WaitForExit(60000) | Out-Null; if (-not $p.HasExited) { $p.Kill() } }
	Write-Host ("    process types seen (samples): {0}" -f (($sightings.Keys | Sort-Object | ForEach-Object { "$_=$($sightings[$_])" }) -join ' '))
	Start-Sleep -Milliseconds 1200
	Get-Content $env:PROBE_LOG -ErrorAction SilentlyContinue | Where-Object { $_ -notmatch 'gpuFeatureStatus|measure' } | ForEach-Object { "    $_" }
}
Remove-Item Env:PROBE_LOG, Env:PROBE_SWITCHES, Env:PROBE_SOFTWARE, Env:PROBE_MEASURE, Env:PROBE_SETTLE_MS, Env:PROBE_TIMEOUT_MS, Env:PROBE_VIA_ARGV -ErrorAction SilentlyContinue
Write-Host 'sightings done'
