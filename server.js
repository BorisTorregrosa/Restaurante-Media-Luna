const express = require('express');
const cors    = require('cors');
const jwt     = require('jsonwebtoken');
const { pool } = require('./db');

const JWT_SECRET = process.env.JWT_SECRET || 'media_luna_secret_key_changeme';
const JWT_EXPIRES = '7d'; // sesión dura 7 días

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(__dirname));

// ================== TEST ==================
app.get('/test', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM productos');
    res.json(result.rows);
  } catch (err) { res.status(500).send(err.message); }
});

// ================== LOGIN ==================
app.post('/login', async (req, res) => {
  const { user, pass } = req.body;
  try {
    const result = await pool.query(
      'SELECT * FROM usuarios WHERE usuario = $1', [user]
    );
    const u = result.rows[0];
    if (!u)               return res.status(400).json({ error: 'Usuario no existe' });
    if (u.password !== pass) return res.status(400).json({ error: 'Contraseña incorrecta' });

    const payload = { id: u.usuarioid, name: u.nombre, role: u.rol };
    const token = jwt.sign(payload, JWT_SECRET, { expiresIn: JWT_EXPIRES });

    res.json({ UsuarioID: u.usuarioid, Nombre: u.nombre, Rol: u.rol, token });
  } catch (err) { res.status(500).send(err.message); }
});

// ================== VERIFICAR TOKEN ==================
app.get('/auth/verify', (req, res) => {
  const auth = req.headers.authorization;
  if (!auth || !auth.startsWith('Bearer '))
    return res.status(401).json({ error: 'Sin token' });
  try {
    const decoded = jwt.verify(auth.slice(7), JWT_SECRET);
    res.json({ UsuarioID: decoded.id, Nombre: decoded.name, Rol: decoded.role });
  } catch {
    res.status(401).json({ error: 'Token inválido o expirado' });
  }
});

// ================== MENÚ COMPLETO (admin y cocinero ven agotados) ==================
app.get('/menu/all', async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT * FROM productos WHERE archivado IS NOT TRUE ORDER BY categoria, nombre'
    );
    res.json(result.rows.map(r => ({
      ProductoID:  r.productoid,
      Nombre:      r.nombre,
      Categoria:   r.categoria,
      Precio:      r.precio,
      Descripcion: r.descripcion,
      Emoji:       r.emoji,
      Tag:         r.tag,
      Imagen:      r.imagen,
      Disponible:  r.disponible
    })));
  } catch (err) { res.status(500).send(err.message); }
});

// ================== MENÚ ==================
app.get('/menu', async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT * FROM productos WHERE disponible = true AND (archivado IS NOT TRUE) ORDER BY categoria, nombre'
    );
    res.json(result.rows.map(r => ({
      ProductoID:  r.productoid,
      Nombre:      r.nombre,
      Categoria:   r.categoria,
      Precio:      r.precio,
      Descripcion: r.descripcion,
      Emoji:       r.emoji,
      Tag:         r.tag,
      Imagen:      r.imagen
    })));
  } catch (err) { res.status(500).send(err.message); }
});

app.post('/menu', async (req, res) => {
  const { name, category, price, desc, emoji, tag, image } = req.body;
  try {
    await pool.query(
      `INSERT INTO productos (nombre, categoria, precio, descripcion, emoji, tag, imagen, disponible)
       VALUES ($1, $2, $3, $4, $5, $6, $7, true)`,
      [name, category, price, desc || '', emoji || '🍽️', tag || '', image || '']
    );
    res.json({ message: 'Plato agregado' });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.put('/menu/:id', async (req, res) => {
  const { name, category, price, desc, emoji, tag, image } = req.body;
  try {
    await pool.query(
      `UPDATE productos
       SET nombre=$1, categoria=$2, precio=$3, descripcion=$4, emoji=$5, tag=$6, imagen=$7
       WHERE productoid=$8`,
      [name, category, price, desc || '', emoji || '🍽️', tag || '', image || '', req.params.id]
    );
    res.json({ message: 'Plato actualizado' });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.delete('/menu/:id', async (req, res) => {
  try {
    // Archivar: marcar como archivado y no disponible, pero conservar el registro intacto
    await pool.query(
      'UPDATE productos SET archivado=true, disponible=false WHERE productoid=$1',
      [req.params.id]
    );
    res.json({ message: 'Plato archivado' });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ================== CREAR PEDIDO ==================
app.post('/orders', async (req, res) => {
  const { items, notes, subtotal, tax, total, userId } = req.body;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await client.query(
      `INSERT INTO pedidos (usuarioid, subtotal, impuesto, total, notas, estado, items)
       VALUES ($1, $2, $3, $4, $5, 'pending', $6) RETURNING pedidoid`,
      [userId, subtotal, tax, total, notes || '', JSON.stringify(items)]
    );
    const pedidoId = result.rows[0].pedidoid;
    for (const item of items) {
      await client.query(
        `INSERT INTO detallepedidos (pedidoid, productoid, cantidad, preciounitario)
         VALUES ($1, $2, $3, $4)`,
        [pedidoId, item.id, item.qty, item.price]
      );
    }
    await client.query('COMMIT');
    res.json({ message: 'Pedido guardado', pedidoId });
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

// ================== VER PEDIDOS ==================
app.get('/orders', async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT p.*, u.nombre
      FROM pedidos p
      JOIN usuarios u ON p.usuarioid = u.usuarioid
      ORDER BY p.fechapedido DESC
    `);
    res.json(result.rows.map(r => ({
      PedidoID:    r.pedidoid,
      UsuarioID:   r.usuarioid,
      Subtotal:    r.subtotal,
      Impuesto:    r.impuesto,
      Total:       r.total,
      Notas:       r.notas,
      Estado:      r.estado,
      Items:       r.items,
      FechaPedido: r.fechapedido,
      Nombre:      r.nombre
    })));
  } catch (err) { res.status(500).send(err.message); }
});

// ================== ACTUALIZAR ESTADO ==================
app.patch('/orders/:id/status', async (req, res) => {
  const { status } = req.body;
  const valid = ['pending', 'preparing', 'ready', 'delivered'];
  if (!valid.includes(status)) return res.status(400).json({ error: 'Estado inválido' });
  try {
    await pool.query(
      'UPDATE pedidos SET estado=$1 WHERE pedidoid=$2', [status, req.params.id]
    );
    res.json({ message: 'Estado actualizado' });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ================== PAPELERÍA: VER ARCHIVADOS ==================
app.get('/menu/archivados', async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT * FROM productos WHERE archivado = true ORDER BY categoria, nombre'
    );
    res.json(result.rows.map(r => ({
      ProductoID:  r.productoid,
      Nombre:      r.nombre,
      Categoria:   r.categoria,
      Precio:      r.precio,
      Descripcion: r.descripcion,
      Emoji:       r.emoji,
      Tag:         r.tag,
      Imagen:      r.imagen
    })));
  } catch (err) { res.status(500).send(err.message); }
});

// ================== PAPELERÍA: RESTAURAR ==================
app.patch('/menu/:id/restaurar', async (req, res) => {
  try {
    await pool.query(
      'UPDATE productos SET archivado=false, disponible=true WHERE productoid=$1',
      [req.params.id]
    );
    res.json({ message: 'Plato restaurado al menú' });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ================== PAPELERÍA: ELIMINAR DEFINITIVAMENTE ==================
app.delete('/menu/:id/definitivo', async (req, res) => {
  try {
    await pool.query('DELETE FROM productos WHERE productoid=$1', [req.params.id]);
    res.json({ message: 'Plato eliminado definitivamente' });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ================== TOGGLE AGOTADO ==================
app.patch('/menu/:id/agotado', async (req, res) => {
  const { agotado } = req.body;
  try {
    await pool.query(
      'UPDATE productos SET disponible=$1 WHERE productoid=$2',
      [!agotado, req.params.id]
    );
    res.json({ message: agotado ? 'Plato marcado como agotado' : 'Plato disponible' });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ================== ELIMINAR PEDIDO ==================
// Con ON DELETE CASCADE en la BD, solo hace falta borrar el pedido principal
app.delete('/orders/:id', async (req, res) => {
  try {
    await pool.query('DELETE FROM pedidos WHERE pedidoid=$1', [req.params.id]);
    res.json({ message: 'Pedido eliminado' });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ================== SERVIDOR ==================
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Servidor corriendo en puerto ${PORT}`));
