// En producción apunta al mismo servidor; en local usa localhost
const API = window.location.hostname === 'localhost' ? 'http://localhost:3000' : '';

// ================== INICIO: detectar QR ==================
// Si la URL tiene ?menu=public muestra directamente el menú del cliente
(function() {
  if (window.location.search.includes('menu=public')) {
    const QR_API = window.location.hostname === 'localhost' ? 'http://localhost:3000' : '';

    async function cargarMenuPublico() {
      try {
        const res = await fetch(QR_API + '/menu');
        const data = await res.json();
        const items = data.map(item => ({
          id: item.ProductoID, name: item.Nombre, category: item.Categoria,
          price: parseFloat(item.Precio), desc: item.Descripcion || '',
          emoji: item.Emoji || '🍽️', tag: item.Tag || '', image: item.Imagen || '',
          available: item.Disponible !== false
        }));
        const grouped = {};
        items.forEach(i => { if (!grouped[i.category]) grouped[i.category] = []; grouped[i.category].push(i); });
        document.getElementById('publicMenuContent').innerHTML = Object.entries(grouped).map(([cat, dishes]) => `
          <div class="public-category">
            <div class="public-category-title">${cat}</div>
            ${dishes.map(item => `
              <div class="public-item${!item.available ? ' public-item-agotado' : ''}">
                <div class="public-item-emoji">${item.emoji}</div>
                <div class="public-item-info">
                  <div class="public-item-name">${item.name}${!item.available ? ' <span class="public-badge-agotado">Agotado</span>' : ''}</div>
                  <div class="public-item-desc">${item.desc}</div>
                  <div class="public-item-price">$${item.price.toFixed(2)}</div>
                </div>
              </div>`).join('')}
          </div>`).join('');
      } catch(e) { console.error('Error cargando menú público', e); }
    }

    document.addEventListener('DOMContentLoaded', () => {
      document.getElementById('loginScreen').style.display = 'none';
      document.getElementById('appScreen').style.display = 'none';
      document.getElementById('publicMenuScreen').style.display = 'block';
      cargarMenuPublico();
      // Auto-refresco cada 30 segundos para reflejar cambios del admin
      setInterval(cargarMenuPublico, 30000);
    });
  }
})();

// ================== RESTAURAR SESIÓN AL CARGAR ==================
// Si hay un token guardado, verificarlo con el servidor y restaurar la sesión
// sin pedirle al usuario que vuelva a hacer login.
(function restoreSession() {
  // No interferir con la vista de menú público QR
  if (window.location.search.includes('menu=public')) return;

  document.addEventListener('DOMContentLoaded', async () => {
    const token = localStorage.getItem('ml_token');
    if (!token) return; // no hay sesión guardada → mostrar login normal

    try {
      const res = await fetch(`${API}/auth/verify`, {
        headers: { 'Authorization': `Bearer ${token}` }
      });
      if (!res.ok) {
        // Token expirado o inválido → limpiar y mostrar login
        localStorage.removeItem('ml_token');
        return;
      }
      const data = await res.json();
      currentUser = { id: data.UsuarioID, name: data.Nombre, role: data.Rol };
      showApp(); // entrar directamente sin pasar por login
    } catch {
      // Sin conexión al verificar → limpiar por seguridad
      localStorage.removeItem('ml_token');
    }
  });
})();
let pollingInterval = null; // auto-refresco de pedidos
let menuItems = [];
let orders = [];
let currentOrder = [];
let currentUser = null;
let activeCategory = 'Todas';
let dashboardPeriod = 'week';
let itemToDelete = null;

// ================== LOGIN ==================
async function doLogin() {
  const u = document.getElementById('loginUser').value.trim();
  const p = document.getElementById('loginPass').value.trim();
  try {
    const res = await fetch(`${API}/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ user: u, pass: p })
    });
    const data = await res.json();
    if (!res.ok) { document.getElementById('loginError').style.display = 'block'; return; }
    document.getElementById('loginError').style.display = 'none';
    // Guardar token en localStorage para persistir la sesión
    localStorage.setItem('ml_token', data.token);
    currentUser = { id: data.UsuarioID, name: data.Nombre, role: data.Rol };
    showApp();
  } catch (err) {
    document.getElementById('loginError').style.display = 'block';
  }
}

function doLogout() {
  stopPolling();
  currentUser = null;
  currentOrder = [];
  localStorage.removeItem('ml_token');
  document.getElementById('appScreen').style.display = 'none';
  document.getElementById('publicMenuScreen').style.display = 'none';
  const ls = document.getElementById('loginScreen');
  ls.style.cssText = 'display:flex; position:fixed; inset:0; width:100%; height:100%; z-index:9999;';
  document.getElementById('loginUser').value = '';
  document.getElementById('loginPass').value = '';
  document.getElementById('loginError').style.display = 'none';
}

// ================== VISTAS ==================
function showApp() {
  document.getElementById('loginScreen').style.cssText = 'display:none;';
  document.getElementById('publicMenuScreen').style.display = 'none';
  document.getElementById('appScreen').style.display = 'block';

  const roleLabels = { admin: 'Administrador', mesero: 'Mesero', cocinero: 'Cocinero' };
  const roleBadgeClass = { admin: 'admin', mesero: 'employee', cocinero: 'cook' };
  const roleBadgeText = { admin: 'Admin', mesero: 'Mesero', cocinero: 'Cocinero' };

  document.getElementById('headerUserName').textContent = currentUser.name;
  document.getElementById('headerUserRole').textContent = roleLabels[currentUser.role] || currentUser.role;

  const badge = document.getElementById('roleBadge');
  badge.textContent = roleBadgeText[currentUser.role] || currentUser.role;
  badge.className = 'role-badge ' + (roleBadgeClass[currentUser.role] || 'employee');

  document.getElementById('adminAddBtn').style.display =
    currentUser.role === 'admin' ? 'block' : 'none';

  // Tabs por rol:
  // admin   → Menú, Pedidos, Balance, QR
  // mesero  → Menú  (solo tomar pedidos)
  // cocinero → Pedidos (solo ver y cambiar estado)
  let tabs = [];
  if (currentUser.role === 'admin') {
    tabs = [
      { id: 'secMenu',       label: '🍽 Menú' },
      { id: 'secOrders',    label: '📋 Pedidos' },
      { id: 'secDashboard', label: '📊 Balance' },
      { id: 'secQR',        label: '📱 Código QR' },
      { id: 'secPapeleria', label: '📦 Papelería' }
    ];
  } else if (currentUser.role === 'mesero') {
    tabs = [{ id: 'secMenu', label: '🍽 Menú' }];
  } else if (currentUser.role === 'cocinero') {
    tabs = [{ id: 'secOrders', label: '📋 Pedidos' }];
  }

  document.getElementById('navTabs').innerHTML = tabs.map(t =>
    `<button class="nav-tab" onclick="showSection('${t.id}')">${t.label}</button>`
  ).join('');

  loadMenu();
  loadOrders();
  generateQR();
  startPolling();

  // Sección inicial según rol
  const firstSection = tabs.length ? tabs[0].id : 'secMenu';
  showSection(firstSection);
}

function showSection(id) {
  document.querySelectorAll('.section').forEach(s => { s.style.display = 'none'; s.classList.remove('active'); });
  const sec = document.getElementById(id);
  sec.style.display = 'block';
  sec.classList.add('active');
  document.querySelectorAll('.nav-tab').forEach(t => {
    t.classList.toggle('active', t.getAttribute('onclick').includes(id));
  });
  if (id === 'secDashboard') renderDashboard();
  if (id === 'secQR') renderQRPreview();
  if (id === 'secPapeleria') loadArchived();
}

function showPublicMenu() {
  document.getElementById('loginScreen').style.display = 'none';
  document.getElementById('appScreen').style.display = 'none';
  document.getElementById('publicMenuScreen').style.display = 'block';
  renderPublicMenu();
}

function showLogin() {
  document.getElementById('publicMenuScreen').style.display = 'none';
  const ls = document.getElementById('loginScreen');
  ls.style.cssText = 'display:flex; position:fixed; inset:0; width:100%; height:100%; z-index:9999;';
}

// ================== MENU ==================
async function loadMenu() {
  try {
    const canSeeAll = currentUser && (currentUser.role === 'admin' || currentUser.role === 'cocinero');
    const endpoint = canSeeAll ? `${API}/menu/all` : `${API}/menu`;
    const res = await fetch(endpoint);
    const data = await res.json();
    menuItems = data.map(item => ({
      id: item.ProductoID, name: item.Nombre, category: item.Categoria,
      price: parseFloat(item.Precio), desc: item.Descripcion || '',
      emoji: item.Emoji || '🍽️', tag: item.Tag || '', image: item.Imagen || '',
      available: item.Disponible !== false && item.Disponible !== 0
    }));
    renderMenu();
    renderPublicMenu();
  } catch (err) { showToast('Error cargando el menú', 'error'); }
}

function getCategories() { return ['Todas', ...new Set(menuItems.map(m => m.category))]; }

function renderMenu() {
  const cats = getCategories();
  document.getElementById('categoryFilter').innerHTML = cats.map(c =>
    `<button class="cat-btn ${c === activeCategory ? 'active' : ''}" onclick="setCategory('${c}')">${c}</button>`
  ).join('');

  const filtered = activeCategory === 'Todas' ? menuItems : menuItems.filter(m => m.category === activeCategory);
  const isAdmin = currentUser && currentUser.role === 'admin';
  const grid = document.getElementById('menuGrid');

  if (!filtered.length) {
    grid.innerHTML = `<div class="empty-state" style="grid-column:1/-1"><div class="icon">🍽️</div><h3>Sin platos</h3><p>No hay platos en esta categoría</p></div>`;
    return;
  }

  const canToggle = currentUser && (currentUser.role === 'admin' || currentUser.role === 'cocinero');
  grid.innerHTML = filtered.map(item => `
    <div class="menu-card${!item.available ? ' card-agotado' : ''}">
      ${isAdmin ? `
        <div class="admin-card-actions">
          <button class="btn-edit-item" onclick="openEditItem(${item.id})" title="Editar">✏️</button>
          <button class="btn-delete-item" onclick="openDeleteItem(${item.id})" title="Eliminar">✕</button>
        </div>` : ''}
      ${canToggle ? `
        <button class="btn-toggle-agotado ${!item.available ? 'btn-toggle-disponible' : ''}" onclick="toggleAgotado(${item.id}, ${!item.available})">
          ${item.available ? 'Marcar agotado' : 'Disponible'}
        </button>` : ''}
      ${!item.available ? `<div class="badge-agotado">Agotado</div>` : ''}
      <div class="menu-card-img">
        ${item.image
          ? `<img src="${item.image}" alt="${item.name}" style="width:100%; height:100%; object-fit:cover; border-radius:2px;" onerror="this.style.display='none'; this.nextElementSibling.style.display='flex';">
             <span style="font-size:72px; line-height:1; filter:drop-shadow(0 4px 8px rgba(0,0,0,0.15)); display:none;">${item.emoji}</span>`
          : `<span style="font-size:72px; line-height:1; filter:drop-shadow(0 4px 8px rgba(0,0,0,0.15));">${item.emoji}</span>`
        }
      </div>
      <div class="menu-card-body">
        <div class="menu-card-category">${item.category}</div>
        <div class="menu-card-name">${item.name}${item.tag ? `<span class="tag ${item.tag}">${item.tag === 'new' ? 'Nuevo' : 'Popular'}</span>` : ''}</div>
        <div class="menu-card-desc">${item.desc}</div>
        <div class="menu-card-footer">
          <div class="menu-card-price">$${item.price.toFixed(2)} <span>COP</span></div>
          ${item.available ? `<button class="btn-add" onclick="addToOrder(${item.id})">+</button>` : `<span class="btn-add-disabled">—</span>`}
        </div>
      </div>
    </div>
  `).join('');
}

function setCategory(cat) { activeCategory = cat; renderMenu(); }

// ================== MENÚ PÚBLICO ==================
function renderPublicMenu() {
  const container = document.getElementById('publicMenuContent');
  if (!menuItems.length) { container.innerHTML = `<p style="color:var(--muted);text-align:center;padding:40px;">Cargando menú...</p>`; return; }
  const cats = [...new Set(menuItems.map(m => m.category))];
  container.innerHTML = cats.map(cat => {
    const items = menuItems.filter(m => m.category === cat);
    return `<div class="public-category-title">${cat}</div>
      <div class="public-menu-grid">
        ${items.map(item => `
          <div class="public-item${!item.available ? ' public-item-agotado' : ''}">
            <div class="public-item-emoji">${item.emoji}</div>
            <div class="public-item-info">
              <div class="public-item-name">${item.name}${!item.available ? ' <span class="public-badge-agotado">Agotado</span>' : ''}</div>
              <div class="public-item-desc">${item.desc}</div>
              <div class="public-item-price">$${item.price.toFixed(2)}</div>
            </div>
          </div>`).join('')}
      </div>`;
  }).join('');
}

// ================== PEDIDO ==================
function addToOrder(id) {
  const item = menuItems.find(m => m.id === id);
  if (!item) return;
  if (!item.available) { showToast('Este plato está agotado', 'error'); return; }
  const existing = currentOrder.find(o => o.id === id);
  if (existing) existing.qty++;
  else currentOrder.push({ ...item, qty: 1 });
  renderCurrentOrder();
  showToast(`${item.emoji} ${item.name} agregado`, 'success');
}

function updateQty(id, delta) {
  const idx = currentOrder.findIndex(o => o.id === id);
  if (idx === -1) return;
  currentOrder[idx].qty += delta;
  if (currentOrder[idx].qty <= 0) currentOrder.splice(idx, 1);
  renderCurrentOrder();
}

function renderCurrentOrder() {
  const container = document.getElementById('currentOrderItems');
  const counter = document.getElementById('orderCounter');
  const summaryPanel = document.getElementById('orderSummaryPanel');
  const totalItems = currentOrder.reduce((s, o) => s + o.qty, 0);
  counter.textContent = `${totalItems} item${totalItems !== 1 ? 's' : ''} seleccionado${totalItems !== 1 ? 's' : ''}`;

  if (!currentOrder.length) {
    container.innerHTML = `<div class="empty-state" style="padding:30px 20px"><div class="icon">🍽️</div><p>Agrega platos al pedido</p></div>`;
    summaryPanel.style.display = 'none';
    return;
  }

  container.innerHTML = currentOrder.map(o => `
    <div class="order-item">
      <div class="order-item-emoji">${o.emoji}</div>
      <div class="order-item-info">
        <div class="order-item-name">${o.name}</div>
        <div class="order-item-price">$${(o.price * o.qty).toFixed(2)}</div>
      </div>
      <div class="qty-control">
        <button class="qty-btn" onclick="updateQty(${o.id}, -1)">−</button>
        <span class="qty-num">${o.qty}</span>
        <button class="qty-btn" onclick="updateQty(${o.id}, 1)">+</button>
      </div>
    </div>`).join('');

  const subtotal = currentOrder.reduce((s, o) => s + o.price * o.qty, 0);
  const tax = subtotal * 0.08;
  const total = subtotal + tax;
  document.getElementById('summarySubtotal').textContent = `$${subtotal.toFixed(2)}`;
  document.getElementById('summaryTax').textContent = `$${tax.toFixed(2)}`;
  document.getElementById('summaryTotal').textContent = `$${total.toFixed(2)}`;
  summaryPanel.style.display = 'block';
}

// ================== ENVIAR PEDIDO ==================
async function placeOrder() {
  if (!currentOrder.length) { showToast('Agrega productos al pedido', 'error'); return; }
  const notes = document.getElementById('orderSpecialNotes').value;
  const subtotal = currentOrder.reduce((s, o) => s + o.price * o.qty, 0);
  const tax = subtotal * 0.08;
  const total = subtotal + tax;
  const orderItems = currentOrder.map(i => ({ id: i.id, qty: i.qty, price: i.price, name: i.name, emoji: i.emoji }));

  try {
    const res = await fetch(`${API}/orders`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId: currentUser.id, items: orderItems, notes, subtotal, tax, total })
    });
    const data = await res.json();
    if (!res.ok) { showToast('Error al enviar el pedido', 'error'); return; }

    showReceipt({ pedidoId: data.pedidoId, items: currentOrder, subtotal, tax, total, notes });
    showToast('✅ Pedido enviado con éxito', 'success');
    currentOrder = [];
    document.getElementById('orderSpecialNotes').value = '';
    renderCurrentOrder();
    loadOrders();
  } catch (err) { showToast('Error de conexión', 'error'); }
}

function buildReceiptHTML(pedidoId, fecha, waiter, items, subtotal, tax, total, notes) {
  return `
    <div class="receipt">
      <div class="receipt-header">
        <div style="font-size:20px; margin-bottom:6px;">✦</div>
        <h2>Restaurante Media Luna</h2>
        <p>Calle 41 #17C- 185 · Cucina Autentica</p>
        <p style="margin-top:8px;">Pedido #${String(pedidoId || '—').padStart(4, '0')}</p>
        <p>${fecha}</p>
        <p>Atendido por: ${waiter}</p>
      </div>
      <div class="receipt-items">
        ${items.map(i => `<div class="receipt-item"><span>${i.qty}× ${i.name}</span><span>$${(i.price * i.qty).toFixed(2)}</span></div>`).join('')}
      </div>
      <hr class="receipt-divider">
      <div class="receipt-item"><span>Subtotal</span><span>$${parseFloat(subtotal).toFixed(2)}</span></div>
      <div class="receipt-item"><span>IVA (8%)</span><span>$${parseFloat(tax).toFixed(2)}</span></div>
      <hr class="receipt-divider">
      <div class="receipt-total"><span>TOTAL</span><span>$${parseFloat(total).toFixed(2)}</span></div>
      ${notes ? `<div style="margin-top:12px; font-size:11px; color:var(--muted); font-style:italic;">📝 ${notes}</div>` : ''}
      <div class="receipt-footer"><p>Grazie per la sua visita!</p><p>✦ Buon Appetito ✦</p></div>
    </div>`;
}

function showReceipt(order) {
  const fecha = new Date().toLocaleString('es-CO', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric', hour: '2-digit', minute: '2-digit' });
  document.getElementById('receiptContent').innerHTML = buildReceiptHTML(
    order.pedidoId, fecha, currentUser.name, order.items, order.subtotal, order.tax, order.total, order.notes
  );
  openModal('modalReceipt');
}

function showOrderReceipt(pedidoId) {
  const o = orders.find(x => x.PedidoID === pedidoId);
  if (!o) return;
  const fecha = new Date(o.FechaPedido).toLocaleString('es-CO', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric', hour: '2-digit', minute: '2-digit' });
  let items = [];
  try { items = o.Items ? JSON.parse(o.Items) : []; } catch {}
  document.getElementById('receiptContent').innerHTML = buildReceiptHTML(
    o.PedidoID, fecha, o.Nombre || '—', items, o.Subtotal, o.Impuesto, o.Total, o.Notas
  );
  openModal('modalReceipt');
}

// ================== PEDIDOS ==================
async function loadOrders(silent = false) {
  try {
    const res = await fetch(`${API}/orders`);
    const newOrders = await res.json();

    // Detectar pedidos nuevos para notificar al cocinero
    if (silent && currentUser && currentUser.role === 'cocinero') {
      const prevIds = new Set(orders.map(o => o.PedidoID));
      const llegaron = newOrders.filter(o => !prevIds.has(o.PedidoID) && o.Estado === 'pending');
      if (llegaron.length > 0) {
        showToast(`🔔 ${llegaron.length === 1 ? 'Nuevo pedido recibido' : llegaron.length + ' nuevos pedidos'}`, 'success');
        // Vibración en móvil si está disponible
        if (navigator.vibrate) navigator.vibrate([200, 100, 200]);
      }
    }

    orders = newOrders;
    renderOrders();
  } catch (err) {
    if (!silent) showToast('Error cargando pedidos', 'error');
  }
}

function startPolling() {
  stopPolling();
  if (!currentUser || currentUser.role === 'mesero') return;
  // Mostrar indicador de auto-refresco
  const indicator = document.getElementById('pollingIndicator');
  if (indicator) indicator.style.display = 'flex';
  pollingInterval = setInterval(() => {
    loadOrders(true);
    // Parpadea el indicador en cada refresco
    if (indicator) {
      indicator.classList.add('pulse-active');
      setTimeout(() => indicator.classList.remove('pulse-active'), 600);
    }
  }, 15000);
}

function stopPolling() {
  if (pollingInterval) { clearInterval(pollingInterval); pollingInterval = null; }
  const indicator = document.getElementById('pollingIndicator');
  if (indicator) indicator.style.display = 'none';
}

function stopPolling() {
  if (pollingInterval) { clearInterval(pollingInterval); pollingInterval = null; }
}

function renderOrders() {
  const container = document.getElementById('ordersContainer');
  const filterStatus = document.getElementById('orderFilterStatus').value;
  const isAdmin = currentUser && currentUser.role === 'admin';
  const isCocinero = currentUser && currentUser.role === 'cocinero';
  const canChangeStatus = isAdmin || isCocinero;
  let filtered = filterStatus ? orders.filter(o => (o.Estado || 'pending') === filterStatus) : orders;

  if (!filtered.length) {
    container.innerHTML = `<div class="empty-state"><div class="icon">📋</div><h3>Sin pedidos</h3><p>No hay pedidos registrados</p></div>`;
    return;
  }

  const statusLabel = { pending: 'Pendiente', preparing: 'Preparando', ready: 'Listo', delivered: 'Entregado' };
  const nextStatus = { pending: 'preparing', preparing: 'ready', ready: 'delivered' };
  const nextLabel = { pending: 'Marcar Preparando', preparing: 'Marcar Listo', ready: 'Marcar Entregado' };

  container.innerHTML = filtered.map(o => {
    const estado = o.Estado || 'pending';
    const fecha = new Date(o.FechaPedido);
    const fechaStr = isNaN(fecha) ? '—' : fecha.toLocaleString('es-CO', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
    let items = [];
    try { items = o.Items ? JSON.parse(o.Items) : []; } catch {}

    return `
      <div class="order-ticket">
        <div class="order-ticket-header">
          <div>
            <div class="order-num">Pedido #${String(o.PedidoID).padStart(4, '0')}</div>
            <div class="order-time">${fechaStr}</div>
          </div>
          <span class="order-status status-${estado}">${statusLabel[estado] || estado}</span>
        </div>
        <div class="order-ticket-body">
          ${items.length ? `
            <ul class="order-items-list">
              ${items.map(i => `
                <li>
                  <span>${i.emoji || ''} <span class="item-qty">${i.qty}×</span> ${i.name}</span>
                  <span class="item-price">$${(i.price * i.qty).toFixed(2)}</span>
                </li>`).join('')}
            </ul>` : ''}
          ${o.Notas ? `<div class="order-notes-display">📝 ${o.Notas}</div>` : ''}
        </div>
        <div class="order-ticket-footer">
          <div>
            <div class="order-ticket-total">Total: $${parseFloat(o.Total).toFixed(2)}</div>
            <div class="order-ticket-waiter">👤 ${o.Nombre || '—'}</div>
          </div>
          <div style="display:flex; gap:8px;">
            ${nextStatus[estado] && canChangeStatus ? `<button class="btn-status" onclick="advanceStatus(${o.PedidoID}, '${nextStatus[estado]}')">${nextLabel[estado]}</button>` : ''}
            <button class="btn-status" onclick="showOrderReceipt(${o.PedidoID})">🖨 Recibo</button>
            ${isAdmin ? `<button class="btn-status" style="background:#c0392b; color:#fff; border-color:#c0392b;" onclick="deleteOrder(${o.PedidoID})">🗑 Eliminar</button>` : ''}
          </div>
        </div>
      </div>`;
  }).join('');
}

async function deleteOrder(pedidoId) {
  if (!confirm(`¿Eliminar el Pedido #${String(pedidoId).padStart(4,'0')}? Esta acción no se puede deshacer.`)) return;

  // Eliminar localmente de inmediato
  orders = orders.filter(o => o.PedidoID !== pedidoId);
  renderOrders();

  try {
    const res = await fetch(`${API}/orders/${pedidoId}`, { method: 'DELETE' });
    if (!res.ok) {
      showToast('Error al eliminar el pedido', 'error');
      loadOrders(); // recargar si falló
      return;
    }
    showToast('🗑 Pedido eliminado', 'success');
  } catch {
    showToast('Sin conexión al servidor', 'error');
    loadOrders();
  }
}

async function advanceStatus(pedidoId, newStatus) {
  // Actualizar localmente de inmediato para respuesta visual instantánea
  const order = orders.find(o => o.PedidoID === pedidoId);
  if (order) order.Estado = newStatus;
  renderOrders();

  try {
    const res = await fetch(`${API}/orders/${pedidoId}/status`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: newStatus })
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      showToast('Error del servidor: ' + (err.error || res.status), 'error');
      // Revertir si el servidor falló
      if (order) order.Estado = Object.keys({pending:'preparing',preparing:'ready',ready:'delivered'}).find(k => ({pending:'preparing',preparing:'ready',ready:'delivered'})[k] === newStatus) || 'pending';
      renderOrders();
      return;
    }
    showToast('✅ Estado actualizado', 'success');
  } catch (err) {
    showToast('Sin conexión al servidor', 'error');
  }
}

// ================== DASHBOARD ==================
function setPeriod(period) {
  dashboardPeriod = period;
  document.getElementById('btnWeek').classList.toggle('active', period === 'week');
  document.getElementById('btnMonth').classList.toggle('active', period === 'month');
  document.getElementById('chartTitle').textContent = period === 'week' ? 'Ingresos de la Semana' : 'Ingresos del Mes';
  renderDashboard();
}

function renderDashboard() {
  const now = new Date();
  const cutoff = new Date(now);
  if (dashboardPeriod === 'week') cutoff.setDate(now.getDate() - 7);
  else cutoff.setDate(now.getDate() - 30);

  const periodOrders = orders.filter(o => new Date(o.FechaPedido) >= cutoff);
  const delivered = periodOrders.filter(o => o.Estado === 'delivered');
  const totalRevenue = delivered.reduce((s, o) => s + parseFloat(o.Total || 0), 0);
  const avgOrder = delivered.length ? totalRevenue / delivered.length : 0;

  let totalItems = 0;
  periodOrders.forEach(o => {
    try { if (o.Items) JSON.parse(o.Items).forEach(i => { totalItems += i.qty; }); } catch {}
  });

  document.getElementById('statsGrid').innerHTML = `
    <div class="stat-card terracotta">
      <div class="stat-label">Ingresos ${dashboardPeriod === 'week' ? 'Semanales' : 'Mensuales'}</div>
      <div class="stat-value">$${totalRevenue.toFixed(0)}</div>
      <div class="stat-sub">COP facturado</div>
    </div>
    <div class="stat-card gold">
      <div class="stat-label">Pedidos Entregados</div>
      <div class="stat-value">${delivered.length}</div>
      <div class="stat-sub">órdenes completadas</div>
    </div>
    <div class="stat-card olive">
      <div class="stat-label">Ticket Promedio</div>
      <div class="stat-value">$${avgOrder.toFixed(2)}</div>
      <div class="stat-sub">por pedido</div>
    </div>
    <div class="stat-card ink">
      <div class="stat-label">Platos Vendidos</div>
      <div class="stat-value">${totalItems}</div>
      <div class="stat-sub">items despachados</div>
    </div>`;

  const days = dashboardPeriod === 'week' ? 7 : 30;
  const weekDays = ['Dom', 'Lun', 'Mar', 'Mié', 'Jue', 'Vie', 'Sáb'];
  const dayTotals = [], dayLabels = [];

  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(now);
    d.setDate(now.getDate() - i);
    const dayStr = d.toDateString();
    const label = dashboardPeriod === 'week' ? weekDays[d.getDay()] : String(d.getDate());
    const dayTotal = orders.filter(o => new Date(o.FechaPedido).toDateString() === dayStr)
      .reduce((s, o) => s + parseFloat(o.Total || 0), 0);
    dayLabels.push(label);
    dayTotals.push(dayTotal);
  }

  const maxVal = Math.max(...dayTotals, 1);
  document.getElementById('barChart').innerHTML = dayTotals.map((val, i) => `
    <div class="bar-group">
      <div class="bar-value">${val > 0 ? '$' + val.toFixed(0) : ''}</div>
      <div class="bar" style="height:${Math.max((val / maxVal) * 160, val > 0 ? 6 : 3)}px" title="$${val.toFixed(2)}"></div>
      <div class="bar-label">${dayLabels[i]}</div>
    </div>`).join('');

  const statusCounts = { pending: 0, preparing: 0, ready: 0, delivered: 0 };
  orders.forEach(o => { const e = o.Estado || 'pending'; if (statusCounts[e] !== undefined) statusCounts[e]++; });

  document.getElementById('statusBreakdown').innerHTML = [
    { key: 'pending', label: 'Pendientes', color: 'var(--gold)' },
    { key: 'preparing', label: 'Preparando', color: 'var(--terracotta)' },
    { key: 'ready', label: 'Listos', color: '#5BC876' },
    { key: 'delivered', label: 'Entregados', color: 'var(--muted)' }
  ].map(s => `
    <div style="display:flex; justify-content:space-between; align-items:center; padding:10px 0; border-bottom:1px solid var(--parchment);">
      <span style="font-size:14px; color:var(--muted);">${s.label}</span>
      <span style="font-family:'DM Mono',monospace; font-size:20px; font-weight:500; color:${s.color};">${statusCounts[s.key]}</span>
    </div>`).join('');

  const dishCount = {};
  orders.forEach(o => {
    try { if (o.Items) JSON.parse(o.Items).forEach(i => { dishCount[i.name] = (dishCount[i.name] || 0) + i.qty; }); } catch {}
  });
  const topDishes = Object.entries(dishCount).sort((a, b) => b[1] - a[1]).slice(0, 5);
  const maxDish = topDishes.length ? topDishes[0][1] : 1;

  document.getElementById('topDishes').innerHTML = topDishes.length
    ? topDishes.map(([name, qty]) => `
        <div style="margin-bottom:10px;">
          <div style="display:flex; justify-content:space-between; margin-bottom:4px; font-size:14px;">
            <span style="color:var(--ink);">${name}</span>
            <span style="font-family:'DM Mono',monospace; color:var(--muted);">${qty}</span>
          </div>
          <div style="background:var(--parchment); border-radius:2px; height:6px;">
            <div style="background:var(--terracotta); height:6px; border-radius:2px; width:${(qty/maxDish)*100}%; transition:width 0.5s;"></div>
          </div>
        </div>`).join('')
    : `<div class="empty-state" style="padding:20px;"><div class="icon">📈</div><p style="font-size:13px;">Sin datos de platos aún</p></div>`;
}

// ================== TOGGLE AGOTADO ==================
async function toggleAgotado(id, currentlyAgotado) {
  try {
    const res = await fetch(`${API}/menu/${id}/agotado`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ agotado: currentlyAgotado })
    });
    if (!res.ok) throw new Error();
    const item = menuItems.find(m => m.id === id);
    if (item) item.available = currentlyAgotado; // currentlyAgotado=true significa "volver a disponible"
    showToast(currentlyAgotado ? '✅ Plato disponible' : '⚠ Plato marcado como agotado', currentlyAgotado ? 'success' : 'error');
    renderMenu();
    renderPublicMenu(); // actualizar menú QR en tiempo real
  } catch { showToast('Error al actualizar el plato', 'error'); }
}

// ================== CRUD MENÚ ==================
function openAddItem() {
  document.getElementById('modalItemTitle').textContent = 'Agregar Plato';
  document.getElementById('editItemId').value = '';
  ['itemName','itemDesc','itemEmoji','itemImage'].forEach(id => document.getElementById(id).value = '');
  document.getElementById('itemCategory').value = 'Antipasti';
  document.getElementById('itemPrice').value = '';
  document.getElementById('itemTag').value = '';
  document.getElementById('imagePreviewWrap').style.display = 'none';
  openModal('modalItem');
}

function openEditItem(id) {
  const item = menuItems.find(m => m.id === id);
  if (!item) return;
  document.getElementById('modalItemTitle').textContent = 'Editar Plato';
  document.getElementById('editItemId').value = id;
  document.getElementById('itemName').value = item.name;
  document.getElementById('itemCategory').value = item.category;
  document.getElementById('itemPrice').value = item.price;
  document.getElementById('itemDesc').value = item.desc;
  document.getElementById('itemEmoji').value = item.emoji;
  document.getElementById('itemTag').value = item.tag || '';
  document.getElementById('itemImage').value = item.image || '';
  const wrap = document.getElementById('imagePreviewWrap');
  if (item.image) {
    document.getElementById('imagePreview').src = item.image;
    wrap.style.display = 'block';
  } else {
    wrap.style.display = 'none';
  }
  openModal('modalItem');
}

async function saveItem() {
  const id = document.getElementById('editItemId').value;
  const body = {
    name: document.getElementById('itemName').value.trim(),
    category: document.getElementById('itemCategory').value,
    price: parseFloat(document.getElementById('itemPrice').value),
    desc: document.getElementById('itemDesc').value.trim(),
    emoji: document.getElementById('itemEmoji').value.trim() || '🍽️',
    tag: document.getElementById('itemTag').value,
    image: document.getElementById('itemImage').value.trim()
  };
  if (!body.name || !body.price) { showToast('Nombre y precio son obligatorios', 'error'); return; }
  try {
    const res = await fetch(id ? `${API}/menu/${id}` : `${API}/menu`, {
      method: id ? 'PUT' : 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    if (!res.ok) throw new Error();
    showToast(id ? '✅ Plato actualizado' : '✅ Plato agregado', 'success');
    closeModal('modalItem');
    loadMenu();
  } catch { showToast('Error guardando el plato', 'error'); }
}

function openDeleteItem(id) { itemToDelete = id; openModal('modalConfirm'); }

async function confirmDelete() {
  if (!itemToDelete) return;
  try {
    const res = await fetch(`${API}/menu/${itemToDelete}`, { method: 'DELETE' });
    if (!res.ok) throw new Error();
    // Remover del array local (queda archivado en BD, no borrado)
    menuItems = menuItems.filter(m => m.id !== itemToDelete);
    showToast('📦 Plato enviado a la Papelería', 'success');
    closeModal('modalConfirm');
    itemToDelete = null;
    renderMenu();
    renderPublicMenu();
  } catch { showToast('Error archivando el plato', 'error'); }
}

// ================== PAPELERÍA ==================
let archivedItems = [];

async function loadArchived() {
  try {
    const res = await fetch(`${API}/menu/archivados`);
    archivedItems = await res.json();
    renderArchived();
  } catch { showToast('Error cargando la papelería', 'error'); }
}

function renderArchived() {
  const container = document.getElementById('archivedGrid');
  if (!container) return;

  if (!archivedItems.length) {
    container.innerHTML = `
      <div class="empty-state" style="grid-column:1/-1; padding:60px 20px">
        <div class="icon">📦</div>
        <h3>Papelería vacía</h3>
        <p>Los platos que elimines del menú aparecerán aquí para poder restaurarlos.</p>
      </div>`;
    return;
  }

  container.innerHTML = archivedItems.map(item => `
    <div class="archived-card">
      <div class="archived-card-img">
        ${item.Imagen
          ? `<img src="${item.Imagen}" alt="${item.Nombre}" style="width:100%;height:100%;object-fit:cover;border-radius:2px;opacity:0.6;" onerror="this.style.display='none';this.nextElementSibling.style.display='flex';">
             <span style="font-size:52px;line-height:1;opacity:0.5;display:none;">${item.Emoji || '🍽️'}</span>`
          : `<span style="font-size:52px;line-height:1;opacity:0.5;">${item.Emoji || '🍽️'}</span>`
        }
        <div class="archived-overlay">Archivado</div>
      </div>
      <div class="archived-card-body">
        <div class="menu-card-category">${item.Categoria}</div>
        <div class="archived-card-name">${item.Nombre}</div>
        <div class="archived-card-price">$${parseFloat(item.Precio).toFixed(2)} <span>COP</span></div>
        <div class="archived-card-actions">
          <button class="btn-restore" onclick="restaurarPlato(${item.ProductoID})">↩ Restaurar</button>
          <button class="btn-delete-perm" onclick="eliminarDefinitivo(${item.ProductoID}, '${item.Nombre.replace(/'/g,"\\'")}')">🗑 Borrar</button>
        </div>
      </div>
    </div>`).join('');
}

async function restaurarPlato(id) {
  try {
    const res = await fetch(`${API}/menu/${id}/restaurar`, { method: 'PATCH' });
    if (!res.ok) throw new Error();
    archivedItems = archivedItems.filter(i => i.ProductoID !== id);
    renderArchived();
    showToast('✅ Plato restaurado al menú', 'success');
    loadMenu(); // recargar el menú activo
  } catch { showToast('Error restaurando el plato', 'error'); }
}

async function eliminarDefinitivo(id, nombre) {
  if (!confirm(`¿Eliminar "${nombre}" de forma permanente? Esta acción no se puede deshacer y borrará el registro completo.`)) return;
  try {
    const res = await fetch(`${API}/menu/${id}/definitivo`, { method: 'DELETE' });
    if (!res.ok) throw new Error();
    archivedItems = archivedItems.filter(i => i.ProductoID !== id);
    renderArchived();
    showToast('🗑 Plato eliminado permanentemente', 'success');
  } catch { showToast('Error eliminando el plato', 'error'); }
}

// ================== MODALES ==================
function openModal(id) { document.getElementById(id).classList.add('active'); }
function closeModal(id) { document.getElementById(id).classList.remove('active'); }

// ================== QR ==================
function generateQR() {
  const qrContainer = document.getElementById('qrcode');
  if (!qrContainer) return;
  qrContainer.innerHTML = '';
  const menuURL = window.location.origin + window.location.pathname + '?menu=public';
  new QRCode(qrContainer, { text: menuURL, width: 160, height: 160 });
}

function renderQRPreview() {
  const preview = document.getElementById('qrPreview');
  if (!preview) return;
  preview.innerHTML = menuItems.slice(0, 6).map(item => `
    <div style="display:flex; gap:8px; padding:8px 0; border-bottom:1px solid rgba(255,255,255,0.06);">
      <span style="font-size:20px;">${item.emoji}</span>
      <div>
        <div style="font-size:13px; color:rgba(255,255,255,0.85); font-style:italic;">${item.name}</div>
        <div style="font-family:'DM Mono',monospace; font-size:11px; color:var(--gold);">$${item.price.toFixed(2)}</div>
      </div>
    </div>`).join('') +
    (menuItems.length > 6 ? `<p style="font-size:11px; color:var(--muted); text-align:center; margin-top:8px;">+${menuItems.length - 6} platos más...</p>` : '');
}

// ================== TOASTS ==================
function showToast(msg, type = 'info') {
  const container = document.getElementById('toastContainer');
  const toast = document.createElement('div');
  toast.className = `toast ${type}`;
  toast.textContent = msg;
  container.appendChild(toast);
  setTimeout(() => toast.remove(), 3000);
}

function previewImage() {
  const url = document.getElementById('itemImage').value.trim();
  const wrap = document.getElementById('imagePreviewWrap');
  const img = document.getElementById('imagePreview');
  if (url) {
    img.src = url;
    wrap.style.display = 'block';
    img.onerror = () => { wrap.style.display = 'none'; };
  } else {
    wrap.style.display = 'none';
  }
}

function printReceipt() {
  const receiptHTML = document.getElementById('receiptContent').innerHTML;
  const win = window.open('', '_blank', 'width=400,height=600');
  win.document.write(`
    <!DOCTYPE html>
    <html>
    <head>
      <meta charset="UTF-8">
      <title>Recibo — Restaurante Media Luna</title>
      <style>
        * { margin: 0; padding: 0; box-sizing: border-box; }
        body {
          font-family: 'Courier New', Courier, monospace;
          font-size: 13px;
          color: #000;
          background: #fff;
          padding: 20px;
          width: 300px;
          margin: 0 auto;
        }
        .receipt-header { text-align: center; margin-bottom: 16px; }
        .receipt-header h2 { font-size: 18px; font-weight: bold; letter-spacing: 2px; }
        .receipt-header p { font-size: 11px; color: #555; margin-top: 4px; }
        .receipt-meta { font-size: 11px; color: #555; margin-bottom: 12px; border-top: 1px dashed #000; border-bottom: 1px dashed #000; padding: 6px 0; }
        .receipt-items { margin-bottom: 8px; }
        .receipt-item { display: flex; justify-content: space-between; margin-bottom: 4px; font-size: 12px; }
        .receipt-divider { border: none; border-top: 1px dashed #000; margin: 8px 0; }
        .receipt-total { display: flex; justify-content: space-between; font-weight: bold; font-size: 15px; margin-top: 6px; }
        .receipt-footer { text-align: center; margin-top: 16px; font-size: 11px; color: #555; border-top: 1px dashed #000; padding-top: 10px; }
        @media print {
          body { width: 100%; padding: 10px; }
        }
      </style>
    </head>
    <body>
      ${receiptHTML}
      <script>
        window.onload = function() {
          window.print();
          setTimeout(() => window.close(), 500);
        };
      <\/script>
    </body>
    </html>
  `);
  win.document.close();
}
