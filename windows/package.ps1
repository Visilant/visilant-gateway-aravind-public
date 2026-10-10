# Run on a Windows x64 build computer with Node 22 and repository dependencies installed.
# Supply complete portable distributions, including DLLs, modules and license notices.
param(
    [Parameter(Mandatory=$true)][string]$DcmtkDirectory,
    [Parameter(Mandatory=$true)][string]$ImageMagickDirectory,
    [string]$OutputDirectory = (Join-Path $PSScriptRoot '..\dist\windows')
)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$root = Split-Path $PSScriptRoot -Parent
Set-Location $root
$node = (Get-Command node.exe -ErrorAction Stop).Source
if (-not (& $node -p 'process.versions.node').StartsWith('22.')) { throw 'Build with Node 22.' }
if ((& $node -p 'process.arch') -ne 'x64') { throw 'Build with Windows x64 Node.' }
$dcmtk = (Resolve-Path $DcmtkDirectory).Path
$magick = (Resolve-Path $ImageMagickDirectory).Path
foreach ($tool in @('echoscu','findscu','storescu','img2dcm','dcm2json','dcmdump','dcmodify')) {
    if (-not (Test-Path (Join-Path $dcmtk "bin\$tool.exe"))) { throw "Missing DCMTK bin\$tool.exe" }
}
if (-not (Test-Path (Join-Path $magick 'magick.exe'))) { throw 'Use a portable ImageMagick distribution with magick.exe at its root.' }
# An installed (not portable) ImageMagick finds its coder modules through registry keys.
# run.ps1 points it at the bundled modules instead, so test the copy the same way: a
# build machine with ImageMagick installed would otherwise pass on its own registry.
$env:MAGICK_CODER_MODULE_PATH = Join-Path $magick 'modules\coders'
$env:MAGICK_FILTER_MODULE_PATH = Join-Path $magick 'modules\filters'
$env:MAGICK_CONFIGURE_PATH = $magick
$magickCheck = Join-Path ([IO.Path]::GetTempPath()) ('visilant-magick-' + [guid]::NewGuid())
New-Item -ItemType Directory -Path $magickCheck | Out-Null
try {
    & (Join-Path $magick 'magick.exe') 'logo:' '-resize' '64x64' (Join-Path $magickCheck 'sample.jpg')
    if ($LASTEXITCODE -ne 0) { throw 'ImageMagick could not write a JPEG image.' }
    & (Join-Path $magick 'magick.exe') (Join-Path $magickCheck 'sample.jpg') '-auto-orient' '-interlace' 'none' (Join-Path $magickCheck 'upright.jpg')
    if ($LASTEXITCODE -ne 0) { throw 'ImageMagick could not read and convert a JPEG image.' }
} finally { Remove-Item -LiteralPath $magickCheck -Recurse -Force }
$tsc = Join-Path $root 'node_modules\typescript\bin\tsc'
if (-not (Test-Path -LiteralPath $tsc)) { throw 'Repository dependencies are missing. Run npm ci in the repository root first.' }
# Build into a clean staging folder, never the developer's build/ tree. That tree keeps
# stale files and source maps from earlier edits, and only the staging output ships.
$stageRoot = Join-Path $root 'build\windows-staging'
if (Test-Path -LiteralPath $stageRoot) { Remove-Item -LiteralPath $stageRoot -Recurse -Force }
$stage = Join-Path $stageRoot 'build'
New-Item -ItemType Directory -Path $stage | Out-Null
# Same compiler and project as npm run build, with source maps off and output redirected.
& $node $tsc --project (Join-Path $root 'tsconfig.json') --outDir $stage --sourceMap false
if ($LASTEXITCODE -ne 0) { throw 'Gateway build failed.' }
# Same UI copy as the copy-ui npm script, into the staging output.
Copy-Item -LiteralPath (Join-Path $root 'src\presentation\ui') -Destination (Join-Path $stage 'src\presentation\ui') -Recurse
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$bundle = Join-Path ([IO.Path]::GetFullPath($OutputDirectory)) "InSight-Gateway-$stamp"
New-Item -ItemType Directory -Path $bundle | Out-Null
$application = New-Item -ItemType Directory -Path (Join-Path $bundle 'application')
Copy-Item $stage $application.FullName -Recurse
Remove-Item -LiteralPath $stageRoot -Recurse -Force
if (Get-ChildItem -LiteralPath (Join-Path $application.FullName 'build') -Recurse -Filter '*.map' -File) { throw 'Source maps reached the bundle. Check the staging build.' }
Copy-Item (Join-Path $root 'package.json'),(Join-Path $root 'package-lock.json') $application.FullName
Push-Location $application.FullName
try {
    & npm.cmd ci --omit=dev
    if ($LASTEXITCODE -ne 0) { throw 'Windows production dependency installation failed.' }
    & $node (Join-Path $PSScriptRoot 'verify-runtime.cjs') (Join-Path $application.FullName 'node_modules\better-sqlite3')
    if ($LASTEXITCODE -ne 0) { throw 'Windows SQLite native runtime check failed.' }
} finally { Pop-Location }
$runtime = New-Item -ItemType Directory -Path (Join-Path $bundle 'runtime')
Copy-Item $node (Join-Path $runtime.FullName 'node.exe')
Copy-Item $dcmtk (Join-Path $runtime.FullName 'dcmtk') -Recurse
Copy-Item $magick (Join-Path $runtime.FullName 'imagemagick') -Recurse
# The Node Windows archive includes LICENSE alongside node.exe. Do not silently omit it.
$nodeLicense = Join-Path (Split-Path $node -Parent) 'LICENSE'
if (-not (Test-Path $nodeLicense)) { throw 'Use the official Node Windows archive and retain its LICENSE alongside node.exe.' }
Copy-Item $nodeLicense (Join-Path $runtime.FullName 'NODE-LICENSE')
Copy-Item (Join-Path $PSScriptRoot 'install.ps1'),(Join-Path $PSScriptRoot 'run.ps1'),(Join-Path $PSScriptRoot 'firewall.ps1'),(Join-Path $PSScriptRoot 'Gateway.cmd'),(Join-Path $PSScriptRoot 'verify-runtime.cjs') $bundle
Copy-Item (Join-Path $root 'docs/windows-gateway.md') (Join-Path $bundle 'README.md')
$manifest = [ordered]@{ version=1; source_commit=(& git rev-parse HEAD); working_tree_dirty=([bool](& git status --porcelain)); built_at=(Get-Date).ToUniversalTime().ToString('o'); files=@() }
$manifest.files = @(Get-ChildItem $bundle -File -Recurse | ForEach-Object {
    @{ path=$_.FullName.Substring($bundle.Length + 1); sha256=(Get-FileHash $_.FullName -Algorithm SHA256).Hash }
})
$manifest | ConvertTo-Json -Depth 5 | Set-Content (Join-Path $bundle 'manifest.json') -Encoding UTF8
Compress-Archive -LiteralPath $bundle -DestinationPath "$bundle.zip"
(Get-FileHash "$bundle.zip" -Algorithm SHA256).Hash | Set-Content "$bundle.zip.sha256"
Write-Host "Ready for transfer: $bundle.zip"
Write-Host 'Verify redistribution terms for the supplied runtime/tool distributions. Test the ZIP on a clean Windows machine before site delivery.'
