const socket = io('http://localhost:3000'); 

let mechanics = [
    {id: 1, name: 'Carlos', skills: ['frenos', 'suspension'], status: 'inactivo', plate: null, startTime: null, activeSince: null, hiddenQueue: [], stats: {frenos: 0, suspension: 0, revision: 0, alineacion: 0}},
    {id: 2, name: 'Camilo', skills: ['frenos'], status: 'inactivo', plate: null, startTime: null, activeSince: null, hiddenQueue: [], stats: {frenos: 0, suspension: 0, revision: 0, alineacion: 0}}
];

let generalQueue = []; // Para Frenos y Suspensión
let fosaQueue = [];    // Para Revisión y Alineación
let selectedService = 'frenos';
let selectedMechanicForLiberar = null;
let userRole = null;   // Control de roles ('tornero' o 'admin')
const PIN_ADMIN = '1234'; // PIN de acceso para Administrador

// ================= CONTROL DE ROLES (LOGIN) =================
document.getElementById('btnRoleTornero').addEventListener('click', () => iniciarApp('tornero'));

document.getElementById('btnRoleAdmin').addEventListener('click', () => {
    const pin = document.getElementById('adminPin').value;
    if (pin === PIN_ADMIN) {
        iniciarApp('admin');
    } else {
        document.getElementById('loginError').style.display = 'block';
        setTimeout(() => document.getElementById('loginError').style.display = 'none', 3000);
    }
});

function iniciarApp(rol) {
    userRole = rol;
    document.getElementById('loginScreen').style.display = 'none'; 
    
    // Configurar permisos visuales según el rol
    if (rol === 'tornero') {
        document.getElementById('navInformesBtn').style.display = 'none'; // Oculta pestaña informes
        document.getElementById('btnAñadirMecanico').style.display = 'none'; // Oculta botón + Añadir
    } else {
        document.getElementById('navInformesBtn').style.display = 'flex';
        document.getElementById('btnAñadirMecanico').style.display = 'block';
    }
    
    renderAll();
}

// ================= AUDIO: TIMBRE Y VOZ =================
function playChime() {
    try {
        const ctx = new (window.AudioContext || window.webkitAudioContext)();
        [880, 1320].forEach((f, i) => {
            const o = ctx.createOscillator(); const g = ctx.createGain();
            o.frequency.value = f; o.connect(g); g.connect(ctx.destination);
            g.gain.setValueAtTime(0.001, ctx.currentTime + i * 0.15);
            g.gain.exponentialRampToValueAtTime(0.2, ctx.currentTime + i * 0.15 + 0.02);
            g.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + i * 0.15 + 0.3);
            o.start(ctx.currentTime + i * 0.15); o.stop(ctx.currentTime + i * 0.15 + 0.32);
        });
    } catch(e) {}
}

function announce(name, plate) {
    playChime();
    setTimeout(() => {
        try {
            const u = new SpeechSynthesisUtterance(`Mecánico ${name}, iniciar trabajo en placa ${plate.split('').join(' ')}`);
            u.lang = 'es-CO'; u.rate = 0.95;
            window.speechSynthesis.speak(u);
        } catch(e) {}
    }, 900);
}

// ================= SINCRONIZACIÓN MAESTRA =================
function sincronizarConServer() {
    socket.emit('sync_master', {
        mecanicos: mechanics,
        espera: [...generalQueue, ...fosaQueue]
    });
}

// ================= MOTOR DE ASIGNACIÓN (FIFO + PREFERENCIAL) =================
function assignNext(mech) {
    let job = null;
    
    if (mech.hiddenQueue.length > 0) {
        job = mech.hiddenQueue.shift();
    } else {
        // 1. Buscar primero en la fila de Revisión / Alineación (Fosa)
        for (let i = 0; i < fosaQueue.length; i++) {
            let currentJob = fosaQueue[i];
            if (mech.skills.includes(currentJob.service)) {
                if (!currentJob.preferidoId || currentJob.preferidoId === mech.id) {
                    job = fosaQueue.splice(i, 1)[0];
                    break; 
                }
            }
        }
        
        // 2. Si no encontró en fosa, buscar en la cola General (Frenos / Suspensión)
        if (!job) {
            for (let i = 0; i < generalQueue.length; i++) {
                let currentJob = generalQueue[i];
                if (mech.skills.includes(currentJob.service)) {
                    if (!currentJob.preferidoId || currentJob.preferidoId === mech.id) {
                        job = generalQueue.splice(i, 1)[0];
                        break; 
                    }
                }
            }
        }
    }

    if (job) {
        mech.status = 'ocupado';
        mech.plate = job.plate;
        mech.currentService = job.service; 
        mech.startTime = Date.now();
        mech.activeSince = null; // Apaga el cronómetro de disponibilidad al ponerse a trabajar
        if (job.service && mech.stats[job.service] !== undefined) mech.stats[job.service]++;
        
        // Avisa a la base de datos quién tomó el turno para los reportes
        socket.emit('asignar_mecanico_db', { placa: job.plate, mecanico_id: mech.id });
        
        announce(mech.name, job.plate);
        return true;
    }
    return false;
}

function tryAutoAssignIdle() {
    let disponibles = mechanics.filter(m => m.status === 'disponible' && m.plate === null);
    disponibles.sort((a, b) => (a.activeSince || 0) - (b.activeSince || 0));
    disponibles.forEach(mech => assignNext(mech));
}

// ================= PESTAÑA 1: REGISTRAR =================
const checkPreferencial = document.getElementById('checkPreferencial');
const selectMecanicoPreferido = document.getElementById('selectMecanicoPreferido');

if(checkPreferencial) {
    checkPreferencial.addEventListener('change', (e) => {
        if (e.target.checked) {
            selectMecanicoPreferido.classList.remove('hidden');
            selectMecanicoPreferido.innerHTML = mechanics
                .filter(m => m.status !== 'inactivo')
                .map(m => `<option value="${m.id}">${m.name}</option>`)
                .join('');
        } else {
            selectMecanicoPreferido.classList.add('hidden');
            selectMecanicoPreferido.innerHTML = '';
        }
    });
}

document.querySelectorAll('#serviceChips .chip').forEach(chip => {
    chip.addEventListener('click', () => {
        document.querySelectorAll('#serviceChips .chip').forEach(c => c.classList.remove('active'));
        chip.classList.add('active');
        selectedService = chip.dataset.service;
    });
});

// ================= RESTRICCIÓN DE PLACA EN TIEMPO REAL =================
document.getElementById('plateInput').addEventListener('input', function(e) {
    this.value = this.value.toUpperCase().replace(/[^A-Z0-9]/g, '');
});

document.getElementById('btnRegistrar').addEventListener('click', () => {
    const plate = document.getElementById('plateInput').value.trim();
    const toast = document.getElementById('toastRegistro');
    
    if (plate.length !== 6) {
        alert('⚠️ La placa debe tener exactamente 6 caracteres (solo letras y números).');
        return;
    }

    let preferidoId = null;
    let preferidoNombre = null;

    if (checkPreferencial && checkPreferencial.checked && selectMecanicoPreferido.value) {
        preferidoId = Number(selectMecanicoPreferido.value);
        preferidoNombre = selectMecanicoPreferido.options[selectMecanicoPreferido.selectedIndex].text;

        const mecanicoElegido = mechanics.find(m => m.id === preferidoId);
        if (mecanicoElegido && !mecanicoElegido.skills.includes(selectedService)) {
            alert(`⚠️ Error: ${preferidoNombre} no realiza el servicio de "${selectedService}". Por favor, verifica el servicio o cambia de mecánico.`);
            return; 
        }
    }

    const turnoNuevo = {
        plate, 
        service: selectedService, 
        ts: Date.now(),
        preferidoId: preferidoId,
        preferidoNombre: preferidoNombre
    };

    if (selectedService === 'revision' || selectedService === 'alineacion') {
        fosaQueue.push(turnoNuevo);
    } else {
        generalQueue.push(turnoNuevo);
    }

    socket.emit('nuevo_turno_db', {
        placa: plate,
        servicio: selectedService,
        mecanico_preferido_id: preferidoId,
        nombre_mecanico_preferido: preferidoNombre
    });

    toast.textContent = `${plate} registrado.`;
    toast.classList.add('show');
    
    document.getElementById('plateInput').value = '';
    if(checkPreferencial) {
        checkPreferencial.checked = false;
        selectMecanicoPreferido.classList.add('hidden');
    }
    
    tryAutoAssignIdle();
    renderAll();
    sincronizarConServer(); 
    setTimeout(() => toast.classList.remove('show'), 3000);
});

// ================= PESTAÑA 2: FIN DE TRABAJO =================
function renderMechOcupados() {
    const list = document.getElementById('mechOcupadosList');
    const ocupados = mechanics.filter(m => m.status === 'ocupado');
    
    ocupados.sort((a, b) => (b.startTime || 0) - (a.startTime || 0));

    if (ocupados.length === 0) return list.innerHTML = '<div class="empty-state">Sin mecánicos ocupados.</div>';
    
    list.innerHTML = ocupados.map(m => `
        <div class="mech-card ${selectedMechanicForLiberar === m.id ? 'selected' : ''}" data-id="${m.id}">
            <div>
                <div class="mech-name">${m.name}</div>
                <div class="mech-plate">${m.plate}</div>
            </div>
            <div class="mech-time">${formatElapsed(m.startTime)}</div>
        </div>
    `).join('');
    
    list.querySelectorAll('.mech-card').forEach(card => {
        card.addEventListener('click', () => {
            selectedMechanicForLiberar = Number(card.dataset.id);
            document.getElementById('btnLiberar').disabled = false;
            renderMechOcupados();
        });
    });
}

function formatElapsed(start) {
    if (!start) return '--:--';
    const s = Math.floor((Date.now() - start) / 1000);
    const m = String(Math.floor(s / 60)).padStart(2, '0');
    const ss = String(s % 60).padStart(2, '0');
    return `${m}:${ss}`;
}

document.getElementById('btnLiberar').addEventListener('click', () => {
    const mech = mechanics.find(m => m.id === selectedMechanicForLiberar);
    if (!mech) return;
    
    mech.status = 'disponible';
    mech.plate = null; 
    mech.startTime = null; 
    mech.currentService = null;
    mech.activeSince = Date.now();
    
    assignNext(mech);
    selectedMechanicForLiberar = null;
    document.getElementById('btnLiberar').disabled = true;
    
    renderAll();
    sincronizarConServer(); 
});

// ================= PESTAÑA 3: PLANTILLA Y CRUD =================
function renderRoster() {
    const list = document.getElementById('rosterList');
    list.innerHTML = mechanics.map(m => {
        // Solo el administrador ve los botones de editar y borrar
        let accionesHtml = '';
        if (userRole === 'admin') {
            accionesHtml = `
                <div class="roster-actions">
                    <button class="icon-btn" onclick="abrirModal(${m.id})">✏️</button>
                    <button class="icon-btn icon-delete" onclick="eliminarMecanico(${m.id})">🗑️</button>
                </div>
            `;
        }

        return `
        <div class="roster-card">
            <div class="roster-top">
                <div>
                    <div class="mech-name" style="display:flex; justify-content:space-between;">
                        ${m.name}
                        ${accionesHtml}
                    </div>
                    <div class="roster-skills">${m.skills.join(' · ')}</div>
                </div>
            </div>
            <div class="seg" style="margin-top:10px;">
                <button class="on-activo ${m.status !== 'inactivo' && m.status !== 'pausa' ? 'sel' : ''}" data-id="${m.id}" data-st="disponible">Activo</button>
                <button class="on-pausa ${m.status === 'pausa' ? 'sel' : ''}" data-id="${m.id}" data-st="pausa">Pausa</button>
                <button class="on-inactivo ${m.status === 'inactivo' ? 'sel' : ''}" data-id="${m.id}" data-st="inactivo">Inactivo</button>
            </div>
        </div>
        `;
    }).join('');
    
    list.querySelectorAll('.seg button').forEach(btn => {
        btn.addEventListener('click', () => {
            const mech = mechanics.find(m => m.id == btn.dataset.id);
            if (mech.status === 'ocupado') return; 
            
            const nuevoEstado = btn.dataset.st;
            if (nuevoEstado === 'disponible' && mech.status !== 'disponible') mech.activeSince = Date.now();
            
            mech.status = nuevoEstado;
            mech.activeSince = mech.status === 'disponible' ? mech.activeSince : null;
            
            if (mech.status === 'disponible') tryAutoAssignIdle();
            
            renderAll();
            sincronizarConServer(); 
        });
    });
}

const modal = document.getElementById('modalMecanico');
document.getElementById('btnAñadirMecanico').addEventListener('click', () => abrirModal());
document.getElementById('btnCancelarModal').addEventListener('click', () => modal.classList.add('hidden'));

function abrirModal(id = null) {
    document.getElementById('modalTitle').innerText = id ? 'Editar Mecánico' : 'Añadir Mecánico';
    document.getElementById('modalId').value = id || '';
    document.getElementById('modalName').value = '';
    document.querySelectorAll('.skill-cb').forEach(cb => cb.checked = false);

    if (id) {
        const m = mechanics.find(x => x.id === id);
        document.getElementById('modalName').value = m.name;
        m.skills.forEach(s => {
            const cb = document.querySelector(`.skill-cb[value="${s}"]`);
            if(cb) cb.checked = true;
        });
    }
    modal.classList.remove('hidden');
}

document.getElementById('btnGuardarModal').addEventListener('click', () => {
    const id = document.getElementById('modalId').value;
    const name = document.getElementById('modalName').value.trim();
    const skills = Array.from(document.querySelectorAll('.skill-cb:checked')).map(cb => cb.value);

    if (!name || skills.length === 0) return alert('Ingresa nombre y al menos una habilidad');

    if (id) {
        const m = mechanics.find(x => x.id == id);
        m.name = name; m.skills = skills;
    } else {
        mechanics.push({
            id: Date.now(), name, skills, status: 'inactivo', plate: null, 
            startTime: null, activeSince: null, hiddenQueue: [],
            stats: {frenos: 0, suspension: 0, revision: 0, alineacion: 0}
        });
    }
    modal.classList.add('hidden');
    renderAll();
    sincronizarConServer();
});

window.eliminarMecanico = function(id) {
    if(confirm('¿Eliminar a este mecánico?')) {
        mechanics = mechanics.filter(m => m.id !== id);
        renderAll();
        sincronizarConServer();
    }
}

// ================= PESTAÑA 4: INFORMES =================
let miGrafico = null; 
let vistaInformeActual = 'general';
const colores = { frenos: '#ef4444', suspension: '#3b82f6', revision: '#f59e0b', alineacion: '#10b981' };

document.getElementById('btnInformeGeneral').addEventListener('click', (e) => cambiarVistaInforme('general', e.target));
document.getElementById('btnInformeMecanicos').addEventListener('click', (e) => cambiarVistaInforme('mecanicos', e.target));
document.getElementById('selectMecanicoInforme').addEventListener('change', renderizarGrafico);

const selectFiltroTiempo = document.getElementById('selectFiltroTiempo');
const inputFechaEspecifica = document.getElementById('inputFechaEspecifica');

selectFiltroTiempo.addEventListener('change', (e) => {
    if (e.target.value === 'especifica') {
        inputFechaEspecifica.classList.remove('hidden');
    } else {
        inputFechaEspecifica.classList.add('hidden');
        renderizarGrafico(); 
    }
});

inputFechaEspecifica.addEventListener('change', renderizarGrafico);

function cambiarVistaInforme(vista, btn) {
    vistaInformeActual = vista;
    document.querySelectorAll('.toggle-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    
    const select = document.getElementById('selectMecanicoInforme');
    if (vista === 'mecanicos') {
        select.classList.remove('hidden');
        select.innerHTML = mechanics.map(m => `<option value="${m.id}">${m.name}</option>`).join('');
    } else {
        select.classList.add('hidden');
    }
    renderizarGrafico();
}

async function renderizarGrafico() {
    if (miGrafico) miGrafico.destroy();
    const ctx = document.getElementById('informeChart').getContext('2d');
    const leyenda = document.getElementById('leyendaInformes');
    const centerText = document.getElementById('chartCenterText');
    
    const filtroTiempo = selectFiltroTiempo.value;
    const fechaEspecifica = inputFechaEspecifica.value;
    const mecanicoElegido = vistaInformeActual === 'general' ? 'general' : document.getElementById('selectMecanicoInforme').value;

    try {
        const url = `http://localhost:3000/api/informes?filtroTiempo=${filtroTiempo}&fechaEspecifica=${fechaEspecifica}&mecanicoId=${mecanicoElegido}`;
        const res = await fetch(url);
        const datos = await res.json();

        const total = Object.values(datos).reduce((a, b) => a + b, 0);
        centerText.innerText = total > 0 ? total : '0';

        miGrafico = new Chart(ctx, {
            type: 'doughnut',
            data: { labels: Object.keys(datos), datasets: [{ data: Object.values(datos), backgroundColor: Object.values(colores), borderWidth: 0 }] },
            options: { cutout: '75%', plugins: { legend: { display: false } } }
        });

        leyenda.innerHTML = Object.keys(datos).map(k => `
            <div class="legend-item">
                <div class="legend-label"><div class="legend-color" style="background: ${colores[k]}"></div>${k}</div>
                <div class="legend-value">${datos[k]}</div>
            </div>`).join('');
            
    } catch (error) {
        console.error("Error consultando informes a la BD:", error);
    }
}

// ================= NAVEGACIÓN Y RENDER =================
document.querySelectorAll('.navbtn').forEach(btn => {
    btn.addEventListener('click', () => {
        document.querySelectorAll('.navbtn').forEach(b => b.classList.remove('active')); btn.classList.add('active');
        document.querySelectorAll('.screen').forEach(s => s.classList.add('hidden'));
        document.getElementById('tab-' + btn.dataset.tab).classList.remove('hidden');
        if(btn.dataset.tab === 'informes') renderizarGrafico();
    });
});

function renderAll() {
    renderMechOcupados(); renderRoster();
}

renderAll();
setInterval(() => { renderMechOcupados(); }, 1000);