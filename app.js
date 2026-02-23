// --- Escenarios ---
const SCENARIOS = [
  { name: "ÓPTIMA",     ppcTarget: 30000, dtK: 7.0 },
  { name: "SEGURA",     ppcTarget: 60000, dtK: 6.0 },
  { name: "ARRIESGADA", ppcTarget: 100000, dtK: 8.0 },
];

function parseList(str, n, name, asFloat=false) {
  const raw = (str || "").split(",").map(s => s.trim()).filter(Boolean);
  if (raw.length === 0) return null;

  if (raw.length === 1 && n > 1) {
    const v = asFloat ? Number(raw[0]) : parseInt(raw[0], 10);
    if (!Number.isFinite(v)) throw new Error(`${name} inválido: ${raw[0]}`);
    const arr = [v, ...Array(n-1).fill(NaN)];
    return arr;
  }
  if (raw.length !== n) throw new Error(`${name} debe tener ${n} valores (o 1 valor). Recibido ${raw.length}.`);
  const out = raw.map(x => asFloat ? Number(x) : parseInt(x, 10));
  if (out.some(v => !Number.isFinite(v))) throw new Error(`${name} contiene valores inválidos.`);
  return out;
}

function gridPoints(e_we, e_sn) {
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
      pairs.push([a,b]);
      if (a !== b) pairs.push([b,a]);
    }
  }
  return pairs;
}

function chooseDecomp(nx, ny, nprocs, minPatch) {
  const aspect = nx / ny;
  let best = null;

  for (const [px, py] of factorPairs(nprocs)) {
    const tx = Math.floor(nx / px);
    const ty = Math.floor(ny / py);
    if (tx < minPatch || ty < minPatch) continue;

    const ratio = px / py;
    const score = Math.abs(Math.log((ratio + 1e-9) / (aspect + 1e-9))) + 0.05 * (Math.abs(tx - ty) / Math.max(1, Math.min(tx, ty)));
    if (!best || score < best.score) best = { score, px, py, tx, ty };
  }

  if (best) return best;

  // fallback: reduce nprocs
  for (let n2 = nprocs - 1; n2 >= 1; n2--) {
    for (const [px, py] of factorPairs(n2)) {
      const tx = Math.floor(nx / px);
      const ty = Math.floor(ny / py);
      if (tx >= minPatch && ty >= minPatch) {
        return { px, py, tx, ty };
      }
    }
  }
  return { px: 1, py: 1, tx: nx, ty: ny };
}

function nestingRatio(dxParent, dxChild) {
  if (!Number.isFinite(dxParent) || !Number.isFinite(dxChild) || dxParent <= 0 || dxChild <= 0) return null;
  const r = dxParent / dxChild;
  const rr = Math.round(r);
  if (Math.abs(r - rr) < 0.15 && rr >= 1) return rr;
  return null;
}

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
        ${rows.map(r => `
          <tr>
            <td>${r.dom}</td>
            <td>${r.px} × ${r.py}</td>
            <td>${r.total}</td>
            <td>${r.tx} × ${r.ty}</td>
            <td>${r.dtParent}</td>
            <td>${r.dtDom}</td>
          </tr>
        `).join("")}
      </tbody>
    </table>
  `;
  return head + table;
}

function compute() {
  const nd = Number(document.getElementById("domains").value);
  const minPatch = Number(document.getElementById("min_patch").value);

  const e_we = parseList(document.getElementById("e_we").value, nd, "e_we", false);
  const e_sn = parseList(document.getElementById("e_sn").value, nd, "e_sn", false);
  const dx   = parseList(document.getElementById("dx_km").value, nd, "dx_km", true); // puede ser null si está vacío

  if (!Number.isFinite(nd) || nd < 1) throw new Error("Nº de dominios inválido.");
  if (!e_we || !e_sn) throw new Error("Debes indicar e_we y e_sn.");
  if (!Number.isFinite(minPatch) || minPatch < 4) throw new Error("min_patch inválido (>=4).");

  const grids = [];
  for (let i=0;i<nd;i++) {
    const g = gridPoints(e_we[i], e_sn[i]);
    grids.push(g);
  }

  // ratios de nesting (si hay dx)
  const ratios = Array(nd).fill(null);
  if (dx && nd >= 2 && Number.isFinite(dx[0])) {
    for (let i=1;i<nd;i++) {
      if (Number.isFinite(dx[i])) ratios[i] = nestingRatio(dx[0], dx[i]);
    }
  }

  const out = [];
  out.push(`<div class="badge">INPUT</div>`);
  out.push(`<p style="color:var(--muted); margin-top:8px">Dominios: <b>${nd}</b></p>`);
  out.push(`<ul style="margin:0; padding-left:18px; color:var(--muted)">` +
    grids.map((g,i) => {
      const dxs = dx ? (Number.isFinite(dx[i]) ? `${dx[i]} km` : "—") : "—";
      return `<li>d${i+1}: e_we=${e_we[i]} e_sn=${e_sn[i]} → nx=${g.nx} ny=${g.ny} pts=${g.pts} · dx=${dxs}</li>`;
    }).join("") +
    `</ul>`);

  for (const scen of SCENARIOS) {
    const dtParentVal = (dx && Number.isFinite(dx[0])) ? Math.round(scen.dtK * dx[0]) : null;
    const dtParent = dtParentVal ? `${dtParentVal}s` : `dt≈${scen.dtK}·dx_km`;

    const rows = grids.map((g, i) => {
      const nprocs = Math.max(1, Math.ceil(g.pts / scen.ppcTarget));
      const dec = chooseDecomp(g.nx, g.ny, nprocs, minPatch);
      const total = dec.px * dec.py;

      let dtDom;
      if (!dtParentVal) {
        dtDom = `dt≈${scen.dtK}·dx_km`;
      } else if (i === 0) {
        dtDom = `${dtParentVal}s`;
      } else {
        const r = ratios[i];
        dtDom = r ? `${Math.max(1, Math.floor(dtParentVal / r))}s (/${r})` : `${dtParentVal}s (sin ratio)`;
      }

      return {
        dom: `d${i+1}`,
        px: dec.px,
        py: dec.py,
        total,
        tx: dec.tx,
        ty: dec.ty,
        dtParent,
        dtDom
      };
    });

    out.push(renderTable(scen.name, rows));
  }

  out.push(`
    <div class="card" style="margin-top:14px">
      <div class="badge">Notas</div>
      <ul style="color:var(--muted); margin:10px 0 0; padding-left:18px">
        <li>Si hay inestabilidad (CFL/blow-up), baja <b>time_step</b> 10–20% o usa perfil <b>SEGURA</b>.</li>
        <li>Si un dominio pequeño no admite muchas particiones, baja <b>min_patch</b> a 8 o acepta menos ranks.</li>
        <li>WRF suele usar un dt del padre y los hijos escalan por ratio (si existe).</li>
      </ul>
    </div>
  `);

  return out.join("\n");
}

function setExample() {
  document.getElementById("domains").value = 3;
  document.getElementById("e_we").value = "74,112,220";
  document.getElementById("e_sn").value = "61,97,190";
  document.getElementById("dx_km").value = "27,9,3";
  document.getElementById("min_patch").value = 10;
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
});

// run inicial
setExample();
document.getElementById("output").innerHTML = compute();