<#
  update.ps1 - Actualizacion automatica de Web MCP Bridge desde la rama main.

  La ejecuta una tarea programada de Windows (cada 10 min, sin ventana); la registra install.ps1.
  Tambien se puede lanzar a mano:
      powershell -ExecutionPolicy Bypass -File scripts\windows\update.ps1 -Python C:\Python314\python.exe

  Que hace:
    1. Solo actua en la rama 'main' y sin cambios locales. Si esta en otra rama YA UNIDA a main y sin cambios,
       vuelve a main sola.
    2. git fetch + avance rapido (--ff-only) a origin/main. Nunca sobrescribe trabajo local.
    3. Si cambio algo en server\ reinicia el puente (install_service.py lo detiene y lo vuelve a arrancar).
    4. Escribe update-stamp.json: la extension lo lee y, si el commit cambio, se recarga sola.
    5. Anota todo en server\update.log.
#>
[CmdletBinding()]
param([string]$Python = '')
$ErrorActionPreference = 'Continue'   # git escribe en stderr aunque todo vaya bien

$Repo = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
Set-Location $Repo
$Log = Join-Path $Repo 'server\update.log'
$Stamp = Join-Path $Repo 'update-stamp.json'

function Write-Log($message) {
  $line = '{0} {1}' -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $message
  Add-Content -Path $Log -Value $line -Encoding UTF8
}

function Write-Stamp($status) {
  $commit = (git rev-parse HEAD 2>$null | Out-String).Trim()
  $branch = (git rev-parse --abbrev-ref HEAD 2>$null | Out-String).Trim()
  $latest = (git rev-parse origin/main 2>$null | Out-String).Trim()
  $data = [ordered]@{ commit = $commit; branch = $branch; latest = $latest; status = $status; checkedAt = (Get-Date).ToUniversalTime().ToString('o') }
  [System.IO.File]::WriteAllText($Stamp, ($data | ConvertTo-Json), (New-Object System.Text.UTF8Encoding($false)))
}

# Recortar el log (ultimas 500 lineas)
if ((Test-Path $Log) -and ((Get-Item $Log).Length -gt 200KB)) {
  $tail = Get-Content $Log -Tail 500 -Encoding UTF8
  Set-Content -Path $Log -Value $tail -Encoding UTF8
}

if (-not (Get-Command git -ErrorAction SilentlyContinue)) { Write-Log 'ERROR git no esta instalado o no esta en el PATH.'; exit 1 }

$branch = (git rev-parse --abbrev-ref HEAD 2>$null | Out-String).Trim()
# En cualquier rama se baja origin/main (solo lectura): el panel de la extension compara con ella para decir si la version es la mas reciente.
git fetch --quiet origin main 2>$null
if ($branch -ne 'main') {
  # Si la rama ya esta unida a main (PR fusionado) y no hay cambios locales, se vuelve a main sola:
  # asi la carpeta no se queda parada en una rama vieja sin actualizarse.
  git merge-base --is-ancestor HEAD origin/main 2>$null
  $unida = ($LASTEXITCODE -eq 0)
  # HEAD igual a main = rama recién creada para trabajar: no se toca
  if (((git rev-parse HEAD) | Out-String).Trim() -eq ((git rev-parse origin/main) | Out-String).Trim()) { $unida = $false }
  $dirty0 = (git status --porcelain --untracked-files=no | Out-String).Trim()
  if ($unida -and -not $dirty0) {
    git checkout --quiet main 2>&1 | Out-Null
    if ($LASTEXITCODE -eq 0) { Write-Log "rama '$branch' ya unida a main: se vuelve a main"; $branch = 'main' }
  }
  if ($branch -ne 'main') {
    Write-Stamp "La carpeta esta en la rama '$branch' (sin unir a main o con cambios): la actualizacion automatica solo sigue 'main'."
    exit 0
  }
}

git fetch --quiet origin main 2>$null
if ($LASTEXITCODE -ne 0) { Write-Stamp 'Sin conexion con GitHub: se reintentara.'; Write-Log 'AVISO git fetch fallo (sin red?).'; exit 0 }

$local = (git rev-parse HEAD | Out-String).Trim()
$remote = (git rev-parse origin/main | Out-String).Trim()
if ($local -eq $remote) { Write-Stamp 'Al dia.'; exit 0 }

$dirty = (git status --porcelain --untracked-files=no | Out-String).Trim()
if ($dirty) {
  Write-Stamp 'Hay cambios locales en archivos del repositorio: no se actualiza para no perderlos.'
  Write-Log "AVISO cambios locales sin guardar, no se actualiza:`n$dirty"
  exit 0
}

$changed = @(git diff --name-only $local $remote)
git merge --ff-only --quiet origin/main 2>$null
if ($LASTEXITCODE -ne 0) {
  Write-Stamp 'No se pudo avanzar a la version nueva (historia distinta). Revisalo a mano con git status.'
  Write-Log 'ERROR git merge --ff-only fallo.'
  exit 1
}
Write-Log ("OK actualizado {0} -> {1} ({2} archivos)" -f $local.Substring(0, 7), $remote.Substring(0, 7), $changed.Count)

# El puente es Python: si cambio, se reinicia para usar el codigo nuevo.
if ($changed | Where-Object { $_ -like 'server/*' }) {
  if (-not $Python) { $Python = (Get-Command python -ErrorAction SilentlyContinue).Source }
  if ($Python) {
    $out = & $Python (Join-Path $Repo 'server\install_service.py') 2>&1 | Out-String
    Add-Content -Path $Log -Value $out.Trim() -Encoding UTF8
    Write-Log "OK puente reiniciado (codigo del servidor cambiado)."
  } else {
    Write-Log 'AVISO cambio el puente pero no se encontro Python para reiniciarlo: ejecuta scripts\windows\install.ps1.'
  }
}

Write-Stamp ("Actualizado a {0}." -f $remote.Substring(0, 7))
