#!/usr/bin/env python3
"""
stage_store.py - Almacen temporal en disco para subir archivos por trozos.

Proposito: el modelo envia el contenido de un archivo grande en varios trozos
(<=150 lineas cada uno). Cada trozo se guarda como archivo .partNN y, al
recibir el ultimo, se concatenan en un solo archivo listo para enviar a GitHub.

Diseno:
* Sin dependencias externas.
* Persistente: sobrevive a reinicios del servidor MCP.
* Atomico: el flush lee los trozos en orden y devuelve el texto final.
* Seguro ante rutas: el stage_id y el path se validan antes de escribir.
"""
from __future__ import annotations

import hashlib
import json
import os
import re
import shutil
import time
from dataclasses import dataclass, field, asdict
from pathlib import Path

ROOT = Path(os.environ.get("WMB_STAGE_DIR") or (Path.home() / ".wmb" / "staging"))
SAFE_ID = re.compile(r"^[A-Za-z0-9_.-]{1,64}$")
STAGE_TTL_SECONDS = 6 * 60 * 60  # 6 horas


@dataclass
class Stage:
    stage_id: str
    path: str
    total_chunks: int | None = None
    received: dict = field(default_factory=dict)  # chunk_index -> sha256
    created_at: float = field(default_factory=time.time)
    updated_at: float = field(default_factory=time.time)

    @property
    def complete(self) -> bool:
        if not self.total_chunks:
            return False
        return len(self.received) >= self.total_chunks


class StageError(RuntimeError):
    pass


def _stage_dir(stage_id: str) -> Path:
    if not SAFE_ID.match(stage_id):
        raise StageError(f"stage_id invalido: {stage_id!r}")
    return ROOT / stage_id


def _meta_path(stage_id: str) -> Path:
    return _stage_dir(stage_id) / "meta.json"


def _load(stage_id: str) -> Stage:
    meta = _meta_path(stage_id)
    if not meta.is_file():
        raise StageError(f"stage_id desconocido: {stage_id}")
    data = json.loads(meta.read_text(encoding="utf-8"))
    return Stage(**data)


def _save(stage: Stage) -> None:
    stage.updated_at = time.time()
    d = _stage_dir(stage.stage_id)
    d.mkdir(parents=True, exist_ok=True)
    tmp = d / "meta.json.tmp"
    tmp.write_text(json.dumps(asdict(stage), ensure_ascii=False), encoding="utf-8")
    tmp.replace(d / "meta.json")


def create(path: str, total_chunks: int | None = None) -> Stage:
    if not path or path.startswith("/") or ".." in Path(path).parts:
        raise StageError(f"path invalido: {path!r}")
    stage_id = hashlib.sha1(f"{path}:{time.time_ns()}".encode()).hexdigest()[:16]
    stage = Stage(stage_id=stage_id, path=path, total_chunks=total_chunks)
    _save(stage)
    return stage


def put(stage_id: str, chunk_index: int, content: str, total_chunks: int | None = None) -> Stage:
    if chunk_index < 0:
        raise StageError("chunk_index debe ser >= 0")
    stage = _load(stage_id)
    if total_chunks is not None:
        if stage.total_chunks and stage.total_chunks != total_chunks:
            raise StageError(f"total_chunks inconsistente (antes {stage.total_chunks}, ahora {total_chunks})")
        stage.total_chunks = total_chunks
    data = content.encode("utf-8")
    part = _stage_dir(stage_id) / f"part{chunk_index:05d}"
    part.write_bytes(data)
    stage.received[str(chunk_index)] = hashlib.sha256(data).hexdigest()
    _save(stage)
    return stage


def read_all(stage_id: str) -> tuple[str, Stage]:
    stage = _load(stage_id)
    if not stage.complete:
        raise StageError(f"faltan trozos: {len(stage.received)}/{stage.total_chunks or '?'}")
    indices = sorted(int(i) for i in stage.received)
    expected = list(range(stage.total_chunks or 0))
    if indices != expected:
        raise StageError(f"trozos incompletos o desordenados: {indices}")
    chunks = []
    for i in indices:
        chunks.append((_stage_dir(stage_id) / f"part{i:05d}").read_text(encoding="utf-8"))
    return "".join(chunks), stage


def abort(stage_id: str) -> None:
    d = _stage_dir(stage_id)
    if d.exists():
        shutil.rmtree(d)


def sweep(ttl_seconds: int = STAGE_TTL_SECONDS) -> int:
    if not ROOT.is_dir():
        return 0
    removed = 0
    now = time.time()
    for child in ROOT.iterdir():
        if not child.is_dir() or not SAFE_ID.match(child.name):
            continue
        meta = child / "meta.json"
        try:
            data = json.loads(meta.read_text(encoding="utf-8"))
            if now - float(data.get("updated_at", 0)) > ttl_seconds:
                shutil.rmtree(child)
                removed += 1
        except Exception:
            continue
    return removed
