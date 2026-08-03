const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');

// IMPORTANTE: Debemos importar la base de datos para que 'pool.query' funcione
const pool = require('./db'); 

const app = express();
const server = http.createServer(app); 

const io = new Server(server, {
    cors: { origin: "*", methods: ["GET", "POST"] }
});

app.use(cors());
app.use(express.json());

// Variables en memoria
let mecanicos = []; 
let turnosEnEspera = [];

// Turno preferencial: Obtener mecánicos activos
app.get('/api/mecanicos/activos', async (req, res) => {
    try {
        const result = await pool.query("SELECT id, nombre FROM mecanicos WHERE estado_asistencia = 'ACTIVO'");
        res.json(result.rows);
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: 'Error obteniendo mecánicos' });
    }
});

// Rutas para que la TV consulte
app.get('/mecanicos', (req, res) => res.json(mecanicos));
app.get('/turnos/en-espera', (req, res) => res.json(turnosEnEspera));
app.get('/turnos/en-proceso', (req, res) => res.json([]));

// ==========================================
// 🔥 NUEVA RUTA: INFORMES AVANZADOS PARA ADMINISTRACIÓN
// ==========================================
app.get('/api/informes', async (req, res) => {
    try {
        const { filtroTiempo, fechaEspecifica, mecanicoId } = req.query;
        
        let query = `
            SELECT 
                tipo_servicio, 
                COUNT(*) as cantidad 
            FROM turnos 
            WHERE 1=1
        `;
        let values = [];
        let paramIndex = 1;

        // 1. Aplicar filtro de fechas
        if (filtroTiempo === 'hoy') {
            query += ` AND DATE(fecha) = CURRENT_DATE`;
        } else if (filtroTiempo === 'semana') {
            query += ` AND fecha >= date_trunc('week', CURRENT_DATE)`;
        } else if (filtroTiempo === 'mes') {
            query += ` AND fecha >= date_trunc('month', CURRENT_DATE)`;
        } else if (filtroTiempo === 'ano') {
            query += ` AND fecha >= date_trunc('year', CURRENT_DATE)`;
        } else if (filtroTiempo === 'especifica' && fechaEspecifica) {
            query += ` AND DATE(fecha) = $${paramIndex}`;
            values.push(fechaEspecifica);
            paramIndex++;
        }

        // 2. Aplicar filtro de mecánico (si no es general)
        if (mecanicoId && mecanicoId !== 'general') {
            query += ` AND mecanico_id = $${paramIndex}`;
            values.push(mecanicoId);
            paramIndex++;
        }

        query += ` GROUP BY tipo_servicio`;

        const result = await pool.query(query, values);
        
        // Formatear resultados para el gráfico
        let stats = { frenos: 0, suspension: 0, revision: 0, alineacion: 0 };
        result.rows.forEach(row => {
            if (stats[row.tipo_servicio] !== undefined) {
                stats[row.tipo_servicio] = parseInt(row.cantidad);
            }
        });

        res.json(stats);
    } catch (error) {
        console.error('Error generando informe:', error);
        res.status(500).json({ error: 'Error generando informe' });
    }
});

// ==========================================
// CONEXIONES DE SOCKET (TIEMPO REAL)
// ==========================================
io.on('connection', (socket) => {
    console.log('🟢 Dispositivo conectado:', socket.id);

    // Guardar ingreso de vehículo
    socket.on('nuevo_turno_db', async (datos) => {
        try {
            const query = `
                INSERT INTO turnos (placa, tipo_servicio, mecanico_preferido_id, nombre_mecanico_preferido) 
                VALUES ($1, $2, $3, $4)
            `;
            await pool.query(query, [
                datos.placa, 
                datos.servicio, 
                datos.mecanico_preferido_id || null, 
                datos.nombre_mecanico_preferido || null
            ]);
            console.log(`✅ Turno guardado en DB: Placa ${datos.placa}`);
        } catch (error) {
            console.error('❌ Error guardando turno en DB:', error);
        }
    });

    // 🔥 NUEVO: Guardar quién atendió el vehículo (Vital para el informe)
    socket.on('asignar_mecanico_db', async (datos) => {
        try {
            const query = `
                UPDATE turnos 
                SET mecanico_id = $1 
                WHERE placa = $2 AND mecanico_id IS NULL
            `;
            await pool.query(query, [datos.mecanico_id, datos.placa]);
        } catch (error) {
            console.error('❌ Error asignando mecánico en DB:', error);
        }
    });

    socket.on('sync_master', (datos) => {
        mecanicos = datos.mecanicos;
        turnosEnEspera = datos.espera;
        io.emit('actualizar_tv');
    });

    socket.on('disconnect', () => {
        console.log('🔴 Dispositivo desconectado:', socket.id);
    });
});

const PORT = 3000;
server.listen(PORT, () => {
    console.log(`🚀 Servidor backend listo en el puerto ${PORT}`);
});