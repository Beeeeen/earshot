# Runs inside the terminal window being filmed. See demo/tools/record-terminal.mjs.
#
# The prompt is the shell's own, the command is typed out character by character
# so the viewer sees it arrive, and the output is whatever the command prints.
# Every step appends "<name> <epoch-ms>" to the events file; a bright marker is
# flashed once before the first prompt so the recording can be aligned to that
# clock without trusting when ffmpeg happened to open the capture.
param(
    [Parameter(Mandatory = $true)][string]$Shot,
    [Parameter(Mandatory = $true)][string]$Go,
    [Parameter(Mandatory = $true)][string]$Events,
    [Parameter(Mandatory = $true)][string]$Root
)

[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$OutputEncoding = [System.Text.Encoding]::UTF8
$ErrorActionPreference = 'Continue'
Set-Location $Root

function Mark([string]$name) {
    $t = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
    Add-Content -Path $Events -Value "$name $t"
}

function TypeAndRun([string]$cmd, [string]$tag) {
    Write-Host -NoNewline (prompt)
    Mark "$tag-type"
    foreach ($ch in $cmd.ToCharArray()) {
        Write-Host -NoNewline $ch
        Start-Sleep -Milliseconds (38 + (Get-Random -Maximum 42))
    }
    Start-Sleep -Milliseconds 450
    Write-Host ''
    Mark "$tag-enter"
    Invoke-Expression $cmd
    Mark "$tag-done"
}

while (-not (Test-Path $Go)) { Start-Sleep -Milliseconds 100 }

Clear-Host
$bar = ''.PadRight([Console]::WindowWidth, [char]0x2588)
for ($i = 0; $i -lt 12; $i++) { Write-Host $bar -ForegroundColor White }
Mark 'marker'
Start-Sleep -Milliseconds 600
Clear-Host
Mark 'clear'
Start-Sleep -Milliseconds 700

switch ($Shot) {
    'tsc' {
        TypeAndRun 'cat src/negative/interpolate-protected.neg.mts' 'cat'
        Write-Host ''
        Start-Sleep -Milliseconds 900
        TypeAndRun 'npx tsc --noEmit --strict --module nodenext --types node src/negative/interpolate-protected.neg.mts' 'tsc'
        Start-Sleep -Seconds 4
    }
    'testall' {
        TypeAndRun 'npm run test:all | Tee-Object -FilePath docs/broll/test-all.txt' 'testall'
        Start-Sleep -Seconds 6
    }
    default { Write-Host "unknown shot $Shot" }
}

Mark 'end'
exit
