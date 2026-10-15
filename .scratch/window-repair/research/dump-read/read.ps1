# Ticket 02's minidump reader.
#
# The two electron.exe dumps from 2026-10-13 are the only surviving evidence of the crash this whole
# effort is about, and this machine has neither cdb nor the .NET SDK to open them with. The format is
# public and small: a header, a stream directory, and per-stream structs. This reads the ones that
# answer the ticket:
#
#   1. the exception record: code, parameters, faulting address;
#   2. the module list with address ranges, so the faulting address can be placed in a module (and so
#      an injected DLL shows up by name);
#   3. whether the crashing thread's stack memory is in the file at all;
#   4. **the printable strings on that stack** - which is where Chromium's own FATAL line lives. That
#      is the only reason the crash can be described in Chromium's words instead of guessed at.
#
# Only ASCII and UTF-16 code units in the printable range are extracted; everything else is reported
# as what it is. If a string this script cannot see is claimed anywhere, that claim is unsupported.
#
#   pwsh -File .scratch/window-repair/research/dump-read/read.ps1 <dump> [<dump>...]
#
# NOTE (learned the hard way): Windows PowerShell 5.1 reads a BOM-less .ps1 as the machine's ANSI code
# page, so this file is deliberately ASCII-only. Anything that needs to say something in Chinese goes
# in the .md next to it, or in a .mjs (Node reads source as UTF-8).
param([Parameter(Mandatory = $true, ValueFromRemainingArguments = $true)][string[]]$Dumps)

$ErrorActionPreference = 'Stop'

# MINIDUMP_THREAD is 48 bytes: ThreadId 0, SuspendCount 4, PriorityClass 8, Priority 12, Teb 16 (8
# bytes, naturally aligned), Stack 24 (a MINIDUMP_MEMORY_DESCRIPTOR: StartOfMemoryRange 24,
# DataSize 32, Rva 36), ThreadContext 40 (DataSize 40, Rva 44). The sizes are read from the file
# rather than assumed.
$THREAD_STRIDE = 48

function Read-Dump([string]$path) {
	Write-Output "===== $path"
	if (-not (Test-Path -LiteralPath $path)) { Write-Output '  (no such file)'; return }
	$b = [System.IO.File]::ReadAllBytes($path)
	Write-Output ("  size {0} bytes, written {1}" -f $b.Length, (Get-Item -LiteralPath $path).LastWriteTime)
	if ([System.BitConverter]::ToUInt32($b, 0) -ne 0x504D444D) { Write-Output '  not a minidump'; return }
	$streamCount = [System.BitConverter]::ToUInt32($b, 8)
	$dirRva = [System.BitConverter]::ToUInt32($b, 12)

	$streams = @{}
	for ($i = 0; $i -lt $streamCount; $i++) {
		$at = $dirRva + $i * 12
		$type = [System.BitConverter]::ToInt32($b, $at)
		if ($type -eq 0) { continue }
		$streams[$type] = @{
			Size = [System.BitConverter]::ToUInt32($b, $at + 4)
			Rva  = [System.BitConverter]::ToUInt32($b, $at + 8)
		}
	}
	Write-Output ("  streams present: {0}" -f (($streams.Keys | Sort-Object) -join ', '))

	# ---- type 7: which Windows generation produced this ----
	if ($streams.ContainsKey(7)) {
		$at = $streams[7].Rva
		Write-Output ("  system: arch {0}, windows {1}.{2}.{3}" -f `
			[System.BitConverter]::ToUInt16($b, $at), `
			[System.BitConverter]::ToUInt32($b, $at + 8), `
			[System.BitConverter]::ToUInt32($b, $at + 12), `
			[System.BitConverter]::ToUInt32($b, $at + 16))
	}

	# ---- type 6: the exception record, and the thread it happened on ----
	$faultAddress = $null
	$faultThread = $null
	if ($streams.ContainsKey(6)) {
		$at = $streams[6].Rva
		$faultThread = [System.BitConverter]::ToUInt32($b, $at)
		$code = [System.BitConverter]::ToUInt32($b, $at + 8)
		$flags = [System.BitConverter]::ToUInt32($b, $at + 12)
		$faultAddress = [System.BitConverter]::ToUInt64($b, $at + 24)
		$parms = @()
		for ($i = 0; $i -lt 4; $i++) {
			$parms += ('0x{0:X}' -f [System.BitConverter]::ToUInt64($b, $at + 32 + $i * 8))
		}
		Write-Output ("  exception: thread {0}, code 0x{1:X8}, flags 0x{2:X}, address 0x{3:X}" -f $faultThread, $code, $flags, $faultAddress)
		Write-Output ("  exception parameters: {0}" -f ($parms -join ' '))
	}

	# ---- type 4: every loaded module, with the range it occupies ----
	$modules = @()
	if ($streams.ContainsKey(4)) {
		$at = $streams[4].Rva
		$count = [System.BitConverter]::ToUInt32($b, $at)
		for ($i = 0; $i -lt $count; $i++) {
			$m = $at + 4 + $i * 108
			$base = [System.BitConverter]::ToUInt64($b, $m)
			$size = [System.BitConverter]::ToUInt32($b, $m + 8)
			$nameRva = [System.BitConverter]::ToUInt32($b, $m + 20)
			if ($nameRva -eq 0 -or $nameRva + 4 -gt $b.Length) { continue }
			$len = [System.BitConverter]::ToUInt32($b, $nameRva)
			if ($nameRva + 4 + $len -gt $b.Length) { $len = $b.Length - $nameRva - 4 }
			$name = [System.Text.Encoding]::Unicode.GetString($b, $nameRva + 4, $len)
			$modules += [pscustomobject]@{ Base = $base; Size = $size; Name = $name }
		}
		Write-Output ("  modules loaded: {0}" -f $modules.Count)
		foreach ($mod in $modules) {
			Write-Output ("    {0:X16}+{1:X8}  {2}" -f $mod.Base, $mod.Size, $mod.Name)
		}
		# Anything that is not a Windows system DLL is worth a second look on this machine.
		$foreign = $modules | Where-Object { $_.Name -notmatch '(?i)^C:\\Windows\\' }
		Write-Output ("  modules NOT under C:\Windows: {0}" -f $foreign.Count)
		foreach ($mod in $foreign) { Write-Output ("    {0}" -f $mod.Name) }
	}

	# ---- type 5 / 9: which memory is actually in the file ----
	if ($streams.ContainsKey(5)) {
		Write-Output ("  memory ranges (list): {0}" -f [System.BitConverter]::ToUInt32($b, $streams[5].Rva))
	}
	if ($streams.ContainsKey(9)) {
		Write-Output ("  memory ranges (64-bit list): {0}" -f [System.BitConverter]::ToUInt64($b, $streams[9].Rva))
	}

	# ---- type 3: threads; the crashing one's stack is where the story is ----
	$faultStack = $null
	if ($streams.ContainsKey(3)) {
		$at = $streams[3].Rva
		$count = [System.BitConverter]::ToUInt32($b, $at)
		$bytesPer = if ($count -gt 0) { [int](($streams[3].Size - 4) / $count) } else { 0 }
		Write-Output ("  threads: {0} (record stride {1} bytes)" -f $count, $bytesPer)
		for ($i = 0; $i -lt $count; $i++) {
			$t = $at + 4 + $i * $bytesPer
			$id = [System.BitConverter]::ToUInt32($b, $t)
			$stackStart = [System.BitConverter]::ToUInt64($b, $t + 24)
			$stackSize = [System.BitConverter]::ToUInt32($b, $t + 32)
			$stackRva = [System.BitConverter]::ToUInt32($b, $t + 36)
			$contextSize = [System.BitConverter]::ToUInt32($b, $t + 40)
			$isFault = $id -eq $faultThread
			if ($i -lt 4 -or $isFault) {
				Write-Output ("    thread {0}: stack 0x{1:X}+{2} bytes (file rva {3}), context {4} bytes{5}" -f `
					$id, $stackStart, $stackSize, $stackRva, $contextSize, $(if ($isFault) { '   <-- the crashing thread' } else { '' }))
			}
			if ($isFault) { $faultStack = @{ Start = $stackStart; Size = $stackSize; Rva = $stackRva } }
		}
	}

	# ---- which module owns the faulting address ----
	if ($null -ne $faultAddress -and $modules.Count -gt 0) {
		$owner = $modules | Where-Object { $faultAddress -ge $_.Base -and $faultAddress -lt ($_.Base + $_.Size) } | Select-Object -First 1
		if ($null -eq $owner) {
			Write-Output '  faulting address is not inside any listed module'
		} else {
			Write-Output ("  faulting address is in {0} +0x{1:X}" -f $owner.Name, ($faultAddress - $owner.Base))
		}
	}

	# ---- the crashing thread's stack, read as text ----
	# This is the part that turns "the GPU process died" into Chromium's own sentence. Both ASCII and
	# UTF-16LE runs are taken; whatever is not printable is not invented.
	if ($null -ne $faultStack) {
		$bytes = $faultStack.Size
		if ($faultStack.Rva + $bytes -gt $b.Length) { $bytes = $b.Length - $faultStack.Rva }
		Write-Output ("  --- strings on the crashing thread's stack ({0} bytes at rva {1}) ---" -f $bytes, $faultStack.Rva)
		$ascii = [System.Text.Encoding]::ASCII.GetString($b, $faultStack.Rva, $bytes)
		foreach ($m in [regex]::Matches($ascii, '[\x20-\x7E]{8,}')) {
			Write-Output ("    A +0x{0:X}: {1}" -f $m.Index, $m.Value)
		}
		$wide = [System.Text.Encoding]::Unicode.GetString($b, $faultStack.Rva, $bytes)
		foreach ($m in [regex]::Matches($wide, '[\x20-\x7E]{8,}')) {
			Write-Output ("    W +0x{0:X}: {1}" -f ($m.Index * 2), $m.Value)
		}
		# The exit code the GPU manager recorded is a negative decimal on the stack; show every
		# printable run that looks like one, truncated or not, so nothing is rounded up into a claim.
		$looksLikeExitCode = [regex]::Matches($ascii, '-1[0-9]{5,}')
		Write-Output ("  --- runs that look like a negative exit code ({0}) ---" -f $looksLikeExitCode.Count)
		foreach ($m in $looksLikeExitCode) { Write-Output ("    A +0x{0:X}: {1}" -f $m.Index, $m.Value) }
	}
}

foreach ($dump in $Dumps) { Read-Dump $dump }
