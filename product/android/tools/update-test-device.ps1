[CmdletBinding()]
param(
    [string]$AvdName = "dsh_hosted_qa",
    [switch]$SkipBuild
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$projectDir = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$sdkCandidates = @(@(
    $env:ANDROID_SDK_ROOT,
    $env:ANDROID_HOME,
    (Join-Path $env:LOCALAPPDATA "Android\Sdk")
) | Where-Object { $_ -and (Test-Path -LiteralPath $_) })

if ($sdkCandidates.Count -eq 0) {
    throw "Android SDK not found. Set ANDROID_SDK_ROOT or install it under LocalAppData."
}

$sdkRoot = $sdkCandidates[0]
$adb = Join-Path $sdkRoot "platform-tools\adb.exe"
$emulator = Join-Path $sdkRoot "emulator\emulator.exe"
if (!(Test-Path -LiteralPath $adb) -or !(Test-Path -LiteralPath $emulator)) {
    throw "Android SDK is missing adb or emulator: $sdkRoot"
}

function Get-RunningAvds {
    $devices = & $adb devices
    foreach ($line in $devices) {
        if ($line -notmatch '^(emulator-\d+)\s+device$') { continue }
        $serial = $Matches[1]
        $nameOutput = & $adb -s $serial emu avd name 2>$null
        $name = $nameOutput | Where-Object { $_ -and $_.Trim() -ne "OK" } | Select-Object -First 1
        if ($name) {
            [PSCustomObject]@{ Serial = $serial; Name = $name.Trim() }
        }
    }
}

$target = Get-RunningAvds | Where-Object Name -eq $AvdName | Select-Object -First 1
if (!$target) {
    $available = @(& $emulator -list-avds)
    if ($AvdName -notin $available) {
        throw "AVD '$AvdName' does not exist. Available AVDs: $($available -join ', ')"
    }

    Write-Host "Starting Android Studio emulator '$AvdName'..."
    # Cold boot avoids stale Quick Boot snapshots while preserving the AVD's user data.
    Start-Process -FilePath $emulator -ArgumentList @("-avd", $AvdName, "-no-snapshot-load")
    $deadline = (Get-Date).AddMinutes(3)
    do {
        Start-Sleep -Seconds 2
        $target = Get-RunningAvds | Where-Object Name -eq $AvdName | Select-Object -First 1
    } until ($target -or (Get-Date) -ge $deadline)
    if (!$target) { throw "AVD '$AvdName' did not become available within 3 minutes." }
}

$bootDeadline = (Get-Date).AddMinutes(3)
do {
    Start-Sleep -Seconds 1
    $booted = (& $adb -s $target.Serial shell getprop sys.boot_completed 2>$null).Trim()
} until ($booted -eq "1" -or (Get-Date) -ge $bootDeadline)
if ($booted -ne "1") { throw "AVD '$AvdName' did not finish booting within 3 minutes." }

if (!$SkipBuild) {
    Push-Location $projectDir
    try {
        & .\gradlew.bat :app:assembleDebug
        if ($LASTEXITCODE -ne 0) { throw "Android debug build failed." }
    } finally {
        Pop-Location
    }
}

$outputDir = Join-Path $projectDir "app\build\outputs\apk\debug"
$metadataPath = Join-Path $outputDir "output-metadata.json"
if (!(Test-Path -LiteralPath $metadataPath)) { throw "Debug APK metadata not found: $metadataPath" }
$metadata = Get-Content -LiteralPath $metadataPath -Raw | ConvertFrom-Json
$element = $metadata.elements | Select-Object -First 1
$applicationId = $metadata.applicationId
$versionNameBuilt = $element.versionName
$versionCodeBuilt = $element.versionCode
if (!$applicationId -or !$versionNameBuilt -or !$versionCodeBuilt) {
    throw "Debug APK metadata is incomplete: $metadataPath"
}
$apkPath = Join-Path $outputDir $element.outputFile
if (!(Test-Path -LiteralPath $apkPath)) { throw "Debug APK not found: $apkPath" }

Write-Host "Updating $applicationId on $AvdName ($($target.Serial)) without clearing app data..."
& $adb -s $target.Serial install -r $apkPath
if ($LASTEXITCODE -ne 0) { throw "APK installation failed." }

$packageInfo = & $adb -s $target.Serial shell dumpsys package $applicationId
$versionName = ($packageInfo | Select-String 'versionName=(\S+)' | Select-Object -First 1).Matches.Groups[1].Value
$versionCode = ($packageInfo | Select-String 'versionCode=(\d+)' | Select-Object -First 1).Matches.Groups[1].Value
if (!$versionName -or !$versionCode) { throw "Installed package version could not be verified." }

$launchOutput = & $adb -s $target.Serial shell am start -W -n "$applicationId/.MainActivity" 2>&1
if ($LASTEXITCODE -ne 0 -or ($launchOutput -join "`n") -notmatch "Status: ok") {
    throw "App installed, but its launcher activity could not be opened."
}

if ($versionName -ne [string]$versionNameBuilt -or $versionCode -ne [string]$versionCodeBuilt) {
    throw "Installed version $versionName ($versionCode) does not match build $versionNameBuilt ($versionCodeBuilt)."
}
Write-Host "Ready for manual testing: $applicationId $versionName ($versionCode) on $AvdName."
