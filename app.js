// app.js
// WRF Tuner — versión “WRF-safe” (unit-safe + dt cap por reasonable_time_step_ratio + ranks robustos)
//
// Cambios clave vs versión anterior:
// 1) dx: acepta "5", "5km", "5000", "5000m" y lo normaliza a metros internamente
// 2) time_step: se calcula por CAP (reasonable_time_step_ratio) en s/km, NO por dt≈k*dx
// 3) procesadores: recomienda usando una lista de totales preferidos (16,20,24,...) evitando descomposiciones peligrosas
// 4) usa nx=e_we-1, ny=e_sn-1 para el patch (como ARW)
//
// Nota: WRF normalmente usa un único -np total para todo el job. Aquí recomendamos un total único
// (basado en d01), y mostramos la descomposición/tile que resultaría para cada dominio.

const SCENARIOS = [
  // safetyFactor multiplica el dt_max (cap) -> dt recomendado
  { name: "ÓPTIMA", safetyFactor: 0.80, preferredTotals: [16, 20, 24, 12, 8, 4, 2, 1] },
  { name: "SEGURA", safetyFactor: 0.70, preferredTotals: [12, 16, 20, 8, 4, 2, 1] },
  { name: "ARRIESGADA", safetyFactor: 0.95, preferredTotals: [16, 20, 24, 32, 36, 12, 8, 4, 2, 1] },
];

// -----------------------------
// Utils parsing
// -----------------------------
function parseIntStrict(x, name) {
  const v = Number.parseInt(String(x).trim(), 10);
  if (!Number.isFinite(v)) throw new Error(`${name} inválido.`);
  return v;
}

function parseListStrict(str, n, name) {
  const raw = String(str || "")
    .split(",")
    .map(s => s.trim())
    .filter(Boolean);

  if (raw.length !== n) {
    throw new Error(`${name} debe tener ${n} valores separados por coma (recibido ${raw.length}).`);
  }
  const out = raw.map((x) => parseIntStrict(x, name));
  return out;
}

function parseDxTokenToMeters(token) {
  // Acepta:
  // - "5" (heurística: <=1000 => km, >1000 => m)
  // - "5km", "5000m"
  // - "0.5km"
  const s = String(token || "").trim().toLowerCase();
  if (!s) return NaN;

  const m = s.match(/^([0-9]*\.?[0-9]+)\s*(km|m)?$/);
  if (!m) throw new Error(`dx inválido: "${token}" (usa 5, 5km, 5000m, 5000)`);

  const val = Number(m[1]);
  const unit = m[2] || null;

  if (!Number.isFinite(val) || val <= 0) throw new Error(`dx inválido: "${token}"`);

  if (unit === "km") return val * 1000.0;
  if (unit === "m") return val;

  // Sin unidad: heurística
  // >1000 => metros; <=1000 => km
  return (val > 1000.0) ? val : (val * 1000.0);
}

function parseDxListToMeters(str, n, name = "dx") {
  const raw = String(str || "")
    .split(",")
    .map(s => s.trim())
    .filter(Boolean);

  if (raw.length === 0) return null;

  if (raw.length === 1 && n > 1) {
    const dx0 = parseDxTokenToMeters(raw[0]);
    return [dx0, ...Array(n - 1).fill(NaN)];
  }

  if (raw.length !== n) {
    throw new Error(`${name} debe tener ${n} valores (o 1 valor). Recibido ${raw.length}.`);
  }

  return raw.map(parseDxTokenToMeters);
}

// -----------------------------
// WRF-ish math
// -----------------------------
function gridPoints(e_we, e_sn) {
  // ARW: nx = e_we - 1, ny = e_sn - 1
  const nx = Math.max(1, e_we - 1);
  const ny = Math.max(1, e_sn - 1);
  return { nx, ny, pts: nx * ny };
}

function factorPairs(n) {
  const pairs = [];
  const r = Math.floor(Math.sqrt(n));
  for (let a = 1; a <= r; a++) {
    if (n % a === 0) {
      const b = n / a;
      pairs.push([a, b]);
      if (a !== b) pairs.push([b, a]);
    }
  }
  return pairs;
}

function scoreDecomp(nx, ny, px, py, tx, ty) {
  // preferir proporción parecida a nx/ny + tiles más “cuadrados”
  const aspect = nx / ny;
  const ratio = px / py;
  const score1 = Math.abs(Math.log((ratio + 1e-9) / (aspect + 1e-9)));
  const score2 = 0.05 * (Math.abs(tx - ty) / Math.max(1, Math.min(tx, ty)));
  return score1 + score2;
}

function chooseDecompForTotal(nx, ny, total, minPatch) {
  // Devuelve mejor (px,py) para ese total, o null si ninguna válida
  const pairs = factorPairs(total);
  let best = null;

  for (const [px, py] of pairs) {
    const tx = Math.floor(nx / px);
    const ty = Math.floor(ny / py);
    if (tx < minPatch || ty < minPatch) continue;

    const score = scoreDecomp(nx, ny, px, py, tx, ty);
    if (!best || score < best.score) best = { score, px, py, tx, ty };
  }
  return best;
}

function recommendTotalAndDecomp(nx, ny, minPatch, preferredTotals) {
  // Recorre totales preferidos y elige el primero que tenga una factorización válida
  for (const total of preferredTotals) {
    const best = chooseDecompForTotal(nx, ny, total, minPatch);
    if (best) return { total, px: best.px, py: best.py, tx: best.tx, ty: best.ty };
  }

  // Fallback: probar descendente desde un máximo razonable (por si el usuario puso cosas raras)
  const maxTry = Math.min(128, Math.max(1, nx * ny)); // cap arbitrario
  for (let total = maxTry; total >= 1; total--) {
    const best = chooseDecompForTotal(nx, ny, total, minPatch);
    if (best) return { total, px: best.px, py: best.py, tx: best.tx, ty: best.ty };
  }

  return { total: 1, px: 1, py: 1, tx: nx, ty: ny };
}

function computeDtByReasonable(dxMeters, reasonableRatio, safetyFactor) {
  // WRF check aproximado: (dt/dx) (s/km) <= reasonable_time_step_ratio
  // dt_max ~= reasonableRatio * dx_km
  if (!Number.isFinite(dxMeters) || dxMeters <= 0) return null;

  const dxKm = dxMeters / 1000.0;
  const dtMax = reasonableRatio * dxKm; // seconds
  const dt = Math.floor(dtMax * safetyFactor);
  return Math.max(1, dt);
}

function nestingRatio(dxParentMeters, dxChildMeters) {
  if (!Number.isFinite(dxParentMeters) || !Number.isFinite(dxChildMeters)) return null;
  if (dxParentMeters <= 0 || dxChildMeters <= 0) return null;
  const r = dxParentMeters / dxChildMeters;
  const rr = Math.round(r);
  if (Math.abs(r - rr) < 0.15 && rr >= 1) return rr;
  return null;
}

function formatDx(dxMeters) {
  if (!Number.isFinite(dxMeters)) return "—";
  const km = dxMeters / 1000.0;
  // mostrar km con hasta 3 decimales si hace falta
  const kmStr = (Math.abs(km - Math.round(km)) < 1e-9) ? String(Math.round(km)) : km.toFixed(3).replace(/0+$/, "").replace(/\.$/, "");
  return `${kmStr} km`;
}

// -----------------------------
// Rendering
// -----------------------------
function renderTable(scenName, rows) {
  const head = `
    <div class="sectionTitle">
      <span class="badge">${scenName}</span>
      <h3>Recomendación</h3>
    </div>
  `;

  const table = `
    <table class="table">
      <thead>
        <tr>
          <th>Dominio</th>
          <th>nproc_x × nproc_y</th>
          <th>Total</th>
          <th>tile_x × tile_y</th>
          <th>time_step (padre)</th>
          <th>time_step (por dominio)</th>
        </tr>
      </thead>
      <tbody>
        ${rows
          .map(
            (r) => `
          <tr>
            <td>${r.dom}</td>
            <td>${r.px} × ${r.py}</td>
            <td>${r.total}</td>
            <td>${r.tx} × ${r.ty}</td>
            <td>${r.dtParent}</td>
            <td>${r.dtDom}</td>
          </tr>
        `
          )
          .join("")}
      </tbody>
    </table>
  `;
  return head + table;
}

// -----------------------------
// Main compute
// -----------------------------
function compute() {
  const nd = Number(document.getElementById("domains").value);
  const minPatch = Number(document.getElementById("min_patch").value);

  // Nuevo: razonable ratio editable (si no existe el input, usamos 6.0)
  const ratioEl = document.getElementById("reasonable_ratio");
  const reasonableRatio = ratioEl ? Number(ratioEl.value) : 6.0;

  if (!Number.isFinite(nd) || nd < 1) throw new Error("Nº de dominios inválido.");
  if (!Number.isFinite(minPatch) || minPatch < 4) throw new Error("min_patch inválido (>=4).");
  if (!Number.isFinite(reasonableRatio) || reasonableRatio <= 0) throw new Error("reasonable_time_step_ratio inválido.");

  const e_we = parseListStrict(document.getElementById("e_we").value, nd, "e_we");
  const e_sn = parseListStrict(document.getElementById("e_sn").value, nd, "e_sn");
  const dxMetersList = parseDxListToMeters(document.getElementById("dx_km").value, nd, "dx"); // permite km/m

  const grids = [];
  for (let i = 0; i < nd; i++) {
    grids.push(gridPoints(e_we[i], e_sn[i]));
  }

  // ratios de nesting (si dx disponible para d1 y di)
  const ratios = Array(nd).fill(null);
  if (dxMetersList && Number.isFinite(dxMetersList[0])) {
    for (let i = 1; i < nd; i++) {
      if (Number.isFinite(dxMetersList[i])) {
        ratios[i] = nestingRatio(dxMetersList[0], dxMetersList[i]);
      }
    }
  }

  const out = [];
  out.push(`<div class="badge">INPUT</div>`);
  out.push(`<p style="color:var(--muted); margin-top:8px">Dominios: <b>${nd}</b> · min_patch: <b>${minPatch}</b> · reasonable_time_step_ratio: <b>${reasonableRatio}</b></p>`);

  out.push(
    `<ul style="margin:0; padding-left:18px; color:var(--muted)">` +
      grids
        .map((g, i) => {
          const dxStr = dxMetersList ? formatDx(dxMetersList[i]) : "—";
          return `<li>d${i + 1}: e_we=${e_we[i]} e_sn=${e_sn[i]} → nx=${g.nx} ny=${g.ny} · dx=${dxStr}</li>`;
        })
        .join("") +
      `</ul>`
  );

  if (!dxMetersList) {
    out.push(
      `<p style="color:var(--muted); margin-top:10px">
        ⚠️ No has indicado dx: para calcular <b>time_step</b> necesitas dx (puedes poner "5", "5km", "5000m").
      </p>`
    );
  }

  // Recomendación de MPI TOTAL: basada en d01 (grid[0]) y escenario
  const g0 = grids[0];

  for (const scen of SCENARIOS) {
    const rec = recommendTotalAndDecomp(g0.nx, g0.ny, minPatch, scen.preferredTotals);
    const totalMPI = rec.total;

    // dt del padre (si dx disponible)
    const dtParentVal =
      dxMetersList && Number.isFinite(dxMetersList[0])
        ? computeDtByReasonable(dxMetersList[0], reasonableRatio, scen.safetyFactor)
        : null;

    const dtParentStr = dtParentVal ? `${dtParentVal}s` : "—";

    const rows = grids.map((g, i) => {
      // para cada dominio, buscamos la mejor factorización para ese TOTAL fijo
      const best = chooseDecompForTotal(g.nx, g.ny, totalMPI, minPatch);
      const px = best ? best.px : 1;
      const py = best ? best.py : totalMPI; // fallback
      const tx = best ? best.tx : g.nx;
      const ty = best ? best.ty : Math.floor(g.ny / Math.max(1, totalMPI));

      let dtDomStr = "—";
      if (dtParentVal) {
        if (i === 0) {
          dtDomStr = `${dtParentVal}s`;
        } else {
          const r = ratios[i];
          if (r) {
            // redondeo: mostramos aproximado; en WRF dependerá de ratios/config
            const dtChild = Math.max(1, Math.round(dtParentVal / r));
            dtDomStr = `${dtChild}s (/${r})`;
          } else {
            dtDomStr = `${dtParentVal}s (sin ratio)`;
          }
        }
      }

      return {
        dom: `d${i + 1}`,
        px,
        py,
        total: px * py,
        tx,
        ty,
        dtParent: dtParentStr,
        dtDom: dtDomStr,
      };
    });

    // Añadimos un encabezado adicional con TOTAL recomendado (para hacerlo explícito)
    out.push(`
      <div class="sectionTitle" style="margin-top:16px">
        <span class="badge">${scen.name}</span>
        <div style="color:var(--muted)">
          MPI total recomendado (d01): <b>${totalMPI}</b> · descomp d01: <b>${rec.px}×${rec.py}</b> · tile d01: <b>${rec.tx}×${rec.ty}</b>
          ${dtParentVal ? ` · time_step(d01): <b>${dtParentVal}s</b>` : ""}
        </div>
      </div>
    `);

    out.push(renderTable("Recommendation", rows));
  }

  out.push(`
    <div class="card" style="margin-top:14px">
      <div class="badge">Notas</div>
      <ul style="color:var(--muted); margin:10px 0 0; padding-left:18px">
        <li><b>time_step</b> aquí se calcula para pasar el chequeo de razonabilidad: <code>dt/dx (s/km) ≤ reasonable_time_step_ratio</code> con un factor de seguridad por escenario.</li>
        <li><b>MPI total</b> se recomienda para <b>d01</b> y se intenta mantener el mismo total en todos los dominios (como un lanzamiento típico de WRF).</li>
        <li>El check de patch usa <code>nx=e_we−1</code>, <code>ny=e_sn−1</code>. Debe cumplirse <code>min(tile_x, tile_y) ≥ min_patch</code>.</li>
        <li>Si usas un total alto (p.ej. 24), <b>fija</b> <code>nproc_x/nproc_y</code> para evitar factorizaciones malas (tipo 2×11) que rompen el patch.</li>
      </ul>
    </div>
  `);

  return out.join("\n");
}

// -----------------------------
// UI wiring
// -----------------------------
function setExample() {
  document.getElementById("domains").value = 2;
  document.getElementById("e_we").value = "134,296";
  document.getElementById("e_sn").value = "100,136";
  document.getElementById("dx_km").value = "5km,1km";
  document.getElementById("min_patch").value = 10;

  const ratioEl = document.getElementById("reasonable_ratio");
  if (ratioEl) ratioEl.value = 6.0;
}

document.getElementById("runBtn").addEventListener("click", () => {
  try {
    document.getElementById("output").innerHTML = compute();
  } catch (e) {
    document.getElementById("output").innerHTML = `<p style="color:#ffb4b4"><b>Error:</b> ${e.message}</p>`;
  }
});

document.getElementById("exampleBtn").addEventListener("click", () => {
  setExample();
  document.getElementById("output").innerHTML = "";
  try {
    document.getElementById("output").innerHTML = compute();
  } catch (e) {
    document.getElementById("output").innerHTML = `<p style="color:#ffb4b4"><b>Error:</b> ${e.message}</p>`;
  }
});

// run inicial
setExample();
try {
  document.getElementById("output").innerHTML = compute();
} catch (e) {
  document.getElementById("output").innerHTML = `<p style="color:#ffb4b4"><b>Error:</b> ${e.message}</p>`;
}