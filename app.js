const supabaseClient = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

// ---- Helpers dùng chung ----
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const tick = () => new Promise(r => setTimeout(r, 0));
const isIgnoredSku = (code) => String(code).startsWith(IGNORED_SKU_PREFIX) || IGNORED_SKU_CODES.includes(String(code));
async function hashPw(username, pw) {
  const subtle = globalThis.crypto && globalThis.crypto.subtle;
  if (!subtle) return pw; // trình duyệt không hỗ trợ -> giữ nguyên (tương thích cũ)
  const buf = new TextEncoder().encode(`${username}:${pw}`);
  const h = await subtle.digest('SHA-256', buf);
  return 'h1:' + Array.from(new Uint8Array(h)).map(b => b.toString(16).padStart(2, '0')).join('');
}
async function pwMatches(stored, username, pw) {
  if (!stored) return false;
  if (String(stored).startsWith('h1:')) return stored === await hashPw(username, pw);
  return stored === pw; // mật khẩu cũ chưa mã hóa, sẽ được nâng cấp khi đăng nhập
}

let currentUser = null;
let activeTab = 'reconcile';
let showPromoInline = false;
let matchTierFilter = 'ALL'; // 'ALL' | 'Premium' | 'Mainstream'
let selectedMonths = [];     // Mảng các tháng được tick chọn, VD: ['2026-11-01', '2026-10-01']

let state = {
  salesReps: [],
  productGroups: [],
  skuMappings: [],
  availableMonths: [],
  reconcileRowsAll: [],
  kvCustomers: [],
  dmsOutlets: [],
  customerLinks: [],
  suggestions: [],
  kvLinesSelected: [],
  dmsLinesSelected: []
};

document.addEventListener('DOMContentLoaded', () => {
  lucide.createIcons();
  renderTierBars();
  checkSavedSession();
  document.addEventListener('click', (e) => {
    const picker = document.getElementById('monthPickerDropdown');
    if (picker && !picker.classList.contains('hidden') && !e.target.closest('#monthPickerDropdown') && !e.target.closest('button[onclick="toggleMonthPicker()"]')) {
      picker.classList.add('hidden');
    }
  });
});

// =========================================================================
// 1. ĐĂNG NHẬP, BẮT BUỘC ĐỔI TK/MK LẦN ĐẦU & PHÂN QUYỀN (ADMIN / SS / SALE)
// =========================================================================
async function checkSavedSession() {
  const saved = localStorage.getItem('cb_bc_user');
  if (saved) {
    try {
      currentUser = JSON.parse(saved);
      const { data: fresh, error: fe } = await supabaseClient.from('reconcile_users')
        .select('id,username,display_name,role,sales_rep_id,must_change_credentials,is_active').eq('id', currentUser.id).maybeSingle();
      if (!fe) {
        if (!fresh || fresh.is_active === false) throw new Error('inactive');
        currentUser = { ...currentUser, ...fresh, must_change_credentials: Boolean(fresh.must_change_credentials) };
        localStorage.setItem('cb_bc_user', JSON.stringify(currentUser));
      }
      if (currentUser.must_change_credentials) {
        showFirstChangeModal();
        return;
      }
      applyUserPermissions();
      return;
    } catch (e) {
      localStorage.removeItem('cb_bc_user');
    }
  }
  document.getElementById('loginScreen').classList.remove('hidden');
  document.getElementById('appShell').classList.add('hidden');
}

async function handleLogin(e) {
  e.preventDefault();
  const username = document.getElementById('loginUsername').value.trim().toLowerCase();
  const password = document.getElementById('loginPassword').value.trim();
  const errEl = document.getElementById('loginErrorMsg');
  const btn = document.getElementById('btnLoginSubmit');

  errEl.classList.add('hidden');
  btn.disabled = true;
  btn.innerText = 'Đang kiểm tra...';

  try {
    const { data: row, error } = await supabaseClient
      .from('reconcile_users')
      .select('*')
      .eq('username', username)
      .eq('is_active', true)
      .maybeSingle();

    if (error) throw error;
    const data = (row && await pwMatches(row.password, row.username, password)) ? row : null;
    if (data && !String(data.password).startsWith('h1:')) {
      const hp = await hashPw(data.username, password);
      if (hp.startsWith('h1:')) await supabaseClient.from('reconcile_users').update({ password: hp }).eq('id', data.id);
    }
    if (!data) {
      errEl.innerText = 'Sai tên đăng nhập hoặc mật khẩu!';
      errEl.classList.remove('hidden');
      return;
    }

    currentUser = {
      id: data.id,
      username: data.username,
      display_name: data.display_name,
      role: data.role,
      sales_rep_id: data.sales_rep_id,
      must_change_credentials: Boolean(data.must_change_credentials)
    };
    localStorage.setItem('cb_bc_user', JSON.stringify(currentUser));

    if (currentUser.must_change_credentials) {
      showFirstChangeModal();
    } else {
      applyUserPermissions();
    }
  } catch (err) {
    errEl.innerText = 'Lỗi kết nối: ' + err.message;
    errEl.classList.remove('hidden');
  } finally {
    btn.disabled = false;
    btn.innerText = 'Đăng Nhập Hệ Thống';
  }
}

function showFirstChangeModal() {
  document.getElementById('loginScreen').classList.add('hidden');
  document.getElementById('appShell').classList.add('hidden');
  document.getElementById('fcNewUsername').value = '';
  document.getElementById('fcNewPassword').value = '';
  document.getElementById('fcConfirmPassword').value = '';
  document.getElementById('firstChangeModal').classList.remove('hidden');
  lucide.createIcons();
}

async function submitFirstTimeChange(e) {
  e.preventDefault();
  const newUser = document.getElementById('fcNewUsername').value.trim().toLowerCase();
  const newPass = document.getElementById('fcNewPassword').value.trim();
  const confirmPass = document.getElementById('fcConfirmPassword').value.trim();
  const errEl = document.getElementById('fcErrorMsg');
  const btn = document.getElementById('btnFcSubmit');

  errEl.classList.add('hidden');
  if (newUser === currentUser.username) {
    errEl.innerText = 'Vui lòng chọn tên đăng nhập mới khác với tài khoản mặc định được cấp!';
    errEl.classList.remove('hidden');
    return;
  }
  if (newPass !== confirmPass) {
    errEl.innerText = 'Mật khẩu xác nhận không khớp!';
    errEl.classList.remove('hidden');
    return;
  }

  btn.disabled = true;
  btn.innerText = 'Đang cập nhật...';

  try {
    const { error } = await supabaseClient
      .from('reconcile_users')
      .update({
        username: newUser,
        password: await hashPw(newUser, newPass),
        must_change_credentials: false
      })
      .eq('id', currentUser.id);

    if (error) {
      errEl.innerText = error.code === '23505'
        ? 'Tên đăng nhập này đã có người dùng, vui lòng chọn tên khác!'
        : 'Lỗi cập nhật: ' + error.message;
      errEl.classList.remove('hidden');
      return;
    }

    currentUser.username = newUser;
    currentUser.must_change_credentials = false;
    localStorage.setItem('cb_bc_user', JSON.stringify(currentUser));
    document.getElementById('firstChangeModal').classList.add('hidden');
    applyUserPermissions();
  } finally {
    btn.disabled = false;
    btn.innerText = 'Lưu & Tiếp Tục';
  }
}

function openChangePwModal() {
  ['cpCurrent', 'cpNew', 'cpConfirm'].forEach(id => { document.getElementById(id).value = ''; });
  document.getElementById('cpMsg').classList.add('hidden');
  document.getElementById('changePwModal').classList.remove('hidden');
}
async function submitChangePw(e) {
  e.preventDefault();
  const cur = document.getElementById('cpCurrent').value.trim();
  const np = document.getElementById('cpNew').value.trim();
  const cf = document.getElementById('cpConfirm').value.trim();
  const msg = document.getElementById('cpMsg');
  const btn = document.getElementById('btnCpSubmit');
  const fail = (t) => { msg.innerText = t; msg.classList.remove('hidden'); };
  msg.classList.add('hidden');
  if (np !== cf) return fail('Mật khẩu xác nhận không khớp!');
  if (np === cur) return fail('Mật khẩu mới phải khác mật khẩu hiện tại!');
  btn.disabled = true;
  try {
    const { data: me, error: e1 } = await supabaseClient.from('reconcile_users').select('id,username,password').eq('id', currentUser.id).maybeSingle();
    if (e1) return fail('Lỗi kết nối: ' + e1.message);
    if (!me || !(await pwMatches(me.password, me.username, cur))) return fail('Mật khẩu hiện tại không đúng!');
    const { error: e2 } = await supabaseClient.from('reconcile_users').update({ password: await hashPw(me.username, np) }).eq('id', currentUser.id);
    if (e2) return fail('Lỗi cập nhật: ' + e2.message);
    closeModal('changePwModal');
    alert('Đã đổi mật khẩu thành công!');
  } finally { btn.disabled = false; }
}

function handleLogout() {
  localStorage.removeItem('cb_bc_user');
  currentUser = null;
  document.getElementById('appShell').classList.add('hidden');
  document.getElementById('firstChangeModal').classList.add('hidden');
  document.getElementById('loginScreen').classList.remove('hidden');
}

function isManagerRole() {
  return currentUser?.role === 'ADMIN' || currentUser?.role === 'SS';
}

function applyUserPermissions() {
  document.getElementById('loginScreen').classList.add('hidden');
  document.getElementById('appShell').classList.remove('hidden');

  const roleLabel = currentUser.role === 'ADMIN' ? 'Admin' : currentUser.role === 'SS' ? 'Sale Sup' : 'Sale';
  document.getElementById('currentUserBadge').innerText = `${currentUser.display_name} (${roleLabel})`;

  document.getElementById('btnAdminUpload').classList.toggle('hidden', !isManagerRole());
  document.getElementById('btnAdminSku').classList.toggle('hidden', !isManagerRole());
  document.getElementById('btnAdminUsers').classList.toggle('hidden', currentUser.role !== 'ADMIN');
  const isAdm = currentUser.role === 'ADMIN';
  document.getElementById('btnStorageRing').classList.toggle('hidden', !isAdm);
  document.getElementById('statusDot').classList.toggle('hidden', isAdm);
  ['btnMenuSku', 'btnMenuLog'].forEach(id => document.getElementById(id).classList.toggle('hidden', !isManagerRole()));
  document.getElementById('btnMenuStorage').classList.toggle('hidden', !isAdm);
  document.getElementById('settingsName').innerText = currentUser.display_name;
  document.getElementById('settingsRole').innerText = roleLabel;
  document.getElementById('settingsAvatar').innerText = (currentUser.display_name || '?').trim().charAt(0).toUpperCase();
  if (isAdm) loadStorageUsage();

  refreshAllData();
}

async function openUsersModal() {
  if (currentUser?.role !== 'ADMIN') return;
  document.getElementById('newUserSalesRep').innerHTML =
    `<option value="">-- Chọn tên Sale --</option>` +
    state.salesReps.map(r => `<option value="${r.id}">${r.full_name}</option>`).join('');
  toggleNewUserSaleSelect();
  await loadUsersList();
  document.getElementById('usersModal').classList.remove('hidden');
}

function toggleNewUserSaleSelect() {
  const role = document.getElementById('newUserRole').value;
  const saleSel = document.getElementById('newUserSalesRep');
  const dispInput = document.getElementById('newDisplayName');

  if (role === 'SALE') {
    saleSel.classList.remove('hidden');
    dispInput.classList.add('hidden');
  } else {
    saleSel.classList.add('hidden');
    saleSel.value = '';
    dispInput.classList.remove('hidden');
    dispInput.placeholder = role === 'SS' ? 'Tên Sale Sup (VD: SS Nguyễn Văn A)' : 'Tên Admin (VD: Admin Phú)';
  }
}

async function loadUsersList() {
  const { data } = await supabaseClient.from('reconcile_users').select('id,username,display_name,role,must_change_credentials,created_at').order('created_at');
  const container = document.getElementById('usersListContainer');
  container.innerHTML = (data || []).map(u => {
    const badgeStyle = u.role === 'ADMIN'
      ? 'bg-amber-100 text-amber-800'
      : u.role === 'SS'
      ? 'bg-indigo-100 text-indigo-800'
      : 'bg-emerald-100 text-emerald-800';
    return `
      <div class="p-3 rounded-xl border border-slate-200 bg-white flex items-center justify-between gap-2 text-xs">
        <div>
          <div class="font-bold text-slate-900">
            ${esc(u.display_name)}
            <span class="text-[10px] px-1.5 py-0.5 rounded font-bold ${badgeStyle}">${u.role}</span>
            ${u.must_change_credentials ? `<span class="text-[10px] text-amber-600 ml-1">(Chờ đổi TK)</span>` : ''}
          </div>
          <div class="text-slate-500 mt-0.5">TK: <b>${esc(u.username)}</b> • MK: <b>••••••</b></div>
        </div>
        <div class="flex items-center gap-1 shrink-0">
          <button onclick="resetUserPassword('${u.id}')" class="text-amber-700 hover:bg-amber-50 p-1.5 rounded-lg" title="Đặt lại mật khẩu tạm">
            <i data-lucide="key" class="w-4 h-4"></i>
          </button>
          ${u.username !== 'admin' ? `
            <button onclick="deleteAppUser('${u.id}')" class="text-rose-600 hover:bg-rose-50 p-1.5 rounded-lg" title="Xóa tài khoản">
              <i data-lucide="trash-2" class="w-4 h-4"></i>
            </button>
          ` : ''}
        </div>
      </div>
    `;
  }).join('');
  lucide.createIcons();
}

async function createAppUser(e) {
  e.preventDefault();
  const username = document.getElementById('newUsername').value.trim().toLowerCase();
  const password = document.getElementById('newPassword').value.trim();
  const role = document.getElementById('newUserRole').value;
  const salesRepId = document.getElementById('newUserSalesRep').value || null;
  const customDisplay = document.getElementById('newDisplayName').value.trim();

  if (role === 'SALE' && !salesRepId) return alert('Vui lòng chọn nhân viên Sale tương ứng!');
  const rep = state.salesReps.find(r => r.id === salesRepId);
  const displayName = role === 'SALE'
    ? rep.full_name
    : (customDisplay || (role === 'SS' ? `Sale Sup (${username})` : `Admin (${username})`));

  const { error } = await supabaseClient.from('reconcile_users').insert({
    username,
    password: await hashPw(username, password),
    display_name: displayName,
    role,
    sales_rep_id: role === 'SALE' ? salesRepId : null,
    must_change_credentials: true
  });
  if (error) return alert('Lỗi tạo tài khoản: ' + error.message);

  document.getElementById('newUsername').value = '';
  document.getElementById('newPassword').value = '';
  document.getElementById('newDisplayName').value = '';
  await loadUsersList();
}

async function resetUserPassword(id) {
  if (currentUser?.role !== 'ADMIN') return;
  const tmp = (prompt('Nhập mật khẩu tạm mới (người dùng sẽ bị buộc đổi lại khi đăng nhập):') || '').trim();
  if (tmp.length < 4) return tmp ? alert('Mật khẩu tối thiểu 4 ký tự!') : undefined;
  const { data: u, error: e1 } = await supabaseClient.from('reconcile_users').select('username').eq('id', id).maybeSingle();
  if (e1 || !u) return alert('Không tìm thấy tài khoản!');
  const { error } = await supabaseClient.from('reconcile_users').update({ password: await hashPw(u.username, tmp), must_change_credentials: true }).eq('id', id);
  if (error) return alert('Lỗi đặt lại mật khẩu: ' + error.message);
  alert('Đã đặt lại mật khẩu tạm.');
  await loadUsersList();
}

async function deleteAppUser(id) {
  if (!confirm('Xóa tài khoản này?')) return;
  await supabaseClient.from('reconcile_users').delete().eq('id', id);
  await loadUsersList();
}

// =========================================================================
// 2. BỘ CHỌN NHIỀU THÁNG (MULTI-SELECT CHECKBOX) & TẢI DỮ LIỆU
// =========================================================================
function toggleMonthPicker() {
  document.getElementById('monthPickerDropdown').classList.toggle('hidden');
}

function renderMonthCheckboxes() {
  const container = document.getElementById('monthCheckboxesList');
  container.innerHTML = state.availableMonths.map(m => {
    const [y, mm] = m.split('-');
    const checked = selectedMonths.includes(m) ? 'checked' : '';
    return `
      <label class="flex items-center gap-2.5 px-2.5 py-1.5 rounded-xl hover:bg-slate-50 cursor-pointer text-xs font-semibold text-slate-800">
        <input type="checkbox" value="${m}" ${checked} class="month-checkbox w-4 h-4 rounded text-emerald-700 focus:ring-emerald-600" onchange="syncSelectAllLabel()" />
        <span>Tháng ${mm}/${y}</span>
      </label>
    `;
  }).join('');
  updateSelectedMonthsLabel();
}

function selectAllMonths() {
  const cbs = [...document.querySelectorAll('.month-checkbox')];
  const allOn = cbs.every(c => c.checked);
  cbs.forEach(c => { c.checked = !allOn; });
  syncSelectAllLabel();
}
function syncSelectAllLabel() {
  const cbs = [...document.querySelectorAll('.month-checkbox')], b = document.getElementById('btnSelectAllMonths');
  if (b) b.innerText = cbs.length && cbs.every(c => c.checked) ? 'Bỏ chọn tất cả' : 'Chọn tất cả';
}

function applyMonthSelection() {
  const checkedVals = Array.from(document.querySelectorAll('.month-checkbox:checked')).map(cb => cb.value);
  if (checkedVals.length === 0) return alert('Vui lòng tick chọn ít nhất 1 tháng!');
  selectedMonths = checkedVals.sort();
  updateSelectedMonthsLabel();
  document.getElementById('monthPickerDropdown').classList.add('hidden');
  onFilterChange();
}

function updateSelectedMonthsLabel() {
  const lbl = document.getElementById('selectedMonthsLabel');
  syncSelectAllLabel();
  if (selectedMonths.length === 0) {
    lbl.innerText = 'Chưa chọn tháng';
    return;
  }
  const sorted = [...selectedMonths].sort();
  if (sorted.length === 1) {
    const [y, mm] = sorted[0].split('-');
    lbl.innerText = `T${mm}/${y}`;
  } else {
    lbl.innerText = `${sorted.length} tháng (${sorted.map(m => 'T' + m.slice(5, 7)).join(', ')})`;
  }
}

async function fetchAllRows(buildQueryFn, orderCols = []) {
  let all = [];
  let from = 0;
  const pageSize = 1000;
  while (true) {
    let q = buildQueryFn();
    orderCols.forEach(c => { q = q.order(c); });
    const { data, error } = await q.range(from, from + pageSize - 1);
    if (error) throw error;
    if (!data || data.length === 0) break;
    all = all.concat(data);
    if (data.length < pageSize) break;
    from += pageSize;
  }
  return all;
}

async function refreshAllData() {
  state._staticOk = false; // nạp lại cả danh sách khách/outlet
  const [resReps, resGroups, resMaps] = await Promise.all([
    supabaseClient.from('sales_reps').select('*').order('full_name'),
    supabaseClient.from('product_groups').select('*').order('display_order'),
    supabaseClient.from('sku_mappings').select('*')
  ]);

  state.salesReps = resReps.data || [];
  state.productGroups = resGroups.data || [];
  state.skuMappings = resMaps.data || [];
  state._tierMap = null;

  const unmapped = state.skuMappings.filter(m => !m.product_group_id && !isIgnoredSku(m.raw_code));
  const alertBox = document.getElementById('unmappedAlert');
  if (unmapped.length > 0) {
    alertBox.classList.remove('hidden');
    alertBox.querySelector('button').classList.toggle('hidden', !isManagerRole());
    document.getElementById('unmappedText').innerText = `${unmapped.length} mã mới (${unmapped.map(u => u.raw_code).join(', ')}) chưa phân nhóm, số liệu các mã này chưa được tính.${isManagerRole() ? '' : ' Báo SS/Admin gán nhóm.'}`;
  } else {
    alertBox.classList.add('hidden');
  }

  const repSelect = document.getElementById('filterSalesRep');
  if (currentUser?.role === 'SALE' && currentUser.sales_rep_id) {
    const myRep = state.salesReps.find(r => r.id === currentUser.sales_rep_id);
    repSelect.innerHTML = `<option value="${currentUser.sales_rep_id}">${myRep ? myRep.full_name : currentUser.display_name}</option>`;
    repSelect.value = currentUser.sales_rep_id;
    repSelect.disabled = true;
  } else {
    const prevRep = repSelect.value;
    repSelect.disabled = false;
    repSelect.innerHTML = `<option value="ALL">Tất cả 5 Sale</option>` +
      state.salesReps.map(r => `<option value="${r.id}">${r.full_name}</option>`).join('');
    if ([...repSelect.options].some(o => o.value === prevRep)) repSelect.value = prevRep;
  }

  const { data: viewMonths, error: vmErr } = await supabaseClient.from('v_available_months').select('month_date');
  if (!vmErr && viewMonths && viewMonths.length > 0) {
    state.availableMonths = viewMonths.map(x => x.month_date).sort().reverse();
  } else {
    const [mKv, mDms] = await Promise.all([
      fetchAllRows(() => supabaseClient.from('kv_sales_lines').select('sale_month')),
      fetchAllRows(() => supabaseClient.from('dms_order_lines').select('order_month'))
    ]);
    state.availableMonths = Array.from(new Set([...mKv.map(x => x.sale_month), ...mDms.map(x => x.order_month)])).sort().reverse();
  }

  if (state.availableMonths.length > 0 && selectedMonths.length === 0) {
    const now = new Date();
    const currentSysMonth = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-01`;
    const defaultMonth = state.availableMonths.includes(currentSysMonth) ? currentSysMonth : state.availableMonths[0];
    selectedMonths = [defaultMonth];
  }
  renderMonthCheckboxes();

  await onFilterChange();
}

async function onFilterChange() {
  if (selectedMonths.length === 0) return;
  const trPromise = loadTransfers();
  const selectedRep = getActiveSalesRepId();
  const buildRepFilter = (q) => (selectedRep && selectedRep !== 'ALL') ? q.eq('sales_rep_id', selectedRep) : q;

  const [recData, kvData, dmsData, kvCData, dmsOData, linksData, resSug] = await Promise.all([
    fetchAllRows(() => buildRepFilter(supabaseClient.from('v_monthly_reconciliation').select('*')), ['month_date', 'product_group_id', 'sales_rep_id']),
    fetchAllRows(() => buildRepFilter(supabaseClient.from('kv_sales_lines').select('*').in('sale_month', selectedMonths)), ['invoice_code', 'raw_product_code', 'selling_price', 'line_index']),
    fetchAllRows(() => buildRepFilter(supabaseClient.from('dms_order_lines').select('*').in('order_month', selectedMonths).eq('dis_code', DIS_CODE)), ['order_code', 'raw_product_code', 'order_type', 'line_index']),
    state._staticOk ? Promise.resolve(state.kvCustomers) : fetchAllRows(() => supabaseClient.from('kv_customers').select('*'), ['kv_customer_code']),
    state._staticOk ? Promise.resolve(state.dmsOutlets) : fetchAllRows(() => supabaseClient.from('dms_outlets').select('*'), ['dms_outlet_code']),
    fetchAllRows(() => supabaseClient.from('customer_links').select('*'), ['id']),
    buildRepFilter(supabaseClient.from('v_customer_match_suggestions').select('*')).order('similarity_score', { ascending: false }).limit(80)
  ]);

  state.reconcileRowsAll = recData;
  state.kvLinesSelected = kvData;
  state.dmsLinesSelected = dmsData;
  state.kvCustomers = kvCData;
  state.dmsOutlets = dmsOData;
  state.customerLinks = linksData;
  state.suggestions = resSug.data || [];
  state._staticOk = true;
  await trPromise;

  renderActiveTab();
}

function switchTab(tabName) {
  activeTab = tabName;
  ['reconcile', 'kv', 'dms', 'custMatch', 'promo'].forEach(t => {
    document.getElementById(`view-${t}`).classList.toggle('hidden', t !== tabName);
    const mBtn = document.getElementById(`mTab-${t}`);
    if (mBtn) mBtn.className = `flex flex-col items-center justify-center py-1 rounded-xl ${t === tabName ? 'text-emerald-700 font-bold' : 'text-slate-400'}`;
    const dBtn = document.getElementById(`dTab-${t}`);
    if (dBtn) dBtn.className = `py-3 text-sm flex items-center gap-2 ${t === tabName ? 'font-bold border-b-2 border-emerald-700 text-emerald-700' : 'font-medium text-slate-500 hover:text-slate-800'}`;
  });
  renderActiveTab();
}

function switchPromoSub(sub) {
  document.getElementById('promoSub-kv').classList.toggle('hidden', sub !== 'kv');
  document.getElementById('promoSub-dms').classList.toggle('hidden', sub !== 'dms');
  document.getElementById('subPromoBtn-kv').className = sub === 'kv'
    ? 'py-2 text-xs font-bold rounded-lg bg-white text-amber-800 shadow-xs'
    : 'py-2 text-xs font-semibold rounded-lg text-slate-600';
  document.getElementById('subPromoBtn-dms').className = sub === 'dms'
    ? 'py-2 text-xs font-bold rounded-lg bg-white text-emerald-800 shadow-xs'
    : 'py-2 text-xs font-semibold rounded-lg text-slate-600';
}

function togglePromoInline() {
  showPromoInline = !showPromoInline;
  document.getElementById('lblTogglePromo').innerText = showPromoInline ? 'Ẩn 0đ / KM' : 'Hiện 0đ / KM';
  renderReconcileTab();
  lucide.createIcons();
}

function setMatchTierFilter(tier) {
  matchTierFilter = tier;
  document.getElementById('tierBtn-ALL').className = tier === 'ALL'
    ? 'py-1.5 font-bold rounded-lg bg-white text-slate-900 shadow-xs'
    : 'py-1.5 font-semibold rounded-lg text-slate-600';
  document.getElementById('tierBtn-Premium').className = tier === 'Premium'
    ? 'py-1.5 font-bold rounded-lg bg-indigo-700 text-white shadow-xs'
    : 'py-1.5 font-semibold rounded-lg text-indigo-800';
  document.getElementById('tierBtn-Mainstream').className = tier === 'Mainstream'
    ? 'py-1.5 font-bold rounded-lg bg-amber-600 text-white shadow-xs'
    : 'py-1.5 font-semibold rounded-lg text-amber-800';
  renderLinkedCustomersComparison();
  lucide.createIcons();
}

function renderActiveTab() {
  if (activeTab === 'reconcile') renderReconcileTab();
  if (activeTab === 'kv') renderKvCustomersTab();
  if (activeTab === 'dms') renderDmsCustomersTab();
  if (activeTab === 'custMatch') renderCustomerMatchTab();
  if (activeTab === 'promo') renderPromoTab();
  lucide.createIcons();
}

function formatBalance(val) {
  const n = Number(val || 0);
  if (n > 0) return `+${n.toLocaleString('vi-VN')}`;
  if (n < 0) return `(${Math.abs(n).toLocaleString('vi-VN')})`;
  return '0';
}
function balanceTextColor(val) {
  const n = Number(val || 0);
  if (n > 0) return 'text-emerald-600';
  if (n < 0) return 'text-rose-600';
  return 'text-slate-500';
}
function balanceCellBg(val) {
  const n = Number(val || 0);
  if (n > 0) return 'bg-emerald-50/90 text-emerald-700';
  if (n < 0) return 'bg-rose-50/90 text-rose-700';
  return 'bg-slate-50 text-slate-600';
}

// =========================================================================
// TAB 1: ĐỐI CHIẾU SẢN LƯỢNG & LŨY KẾ (MÀU SẮC PREMIUM VS MAINSTREAM TÁCH BIỆT)
// =========================================================================
function renderReconcileTab() {
  const sortedSel = [...selectedMonths].sort();
  const firstSelMonth = sortedSel[0];
  const lastSelMonth = sortedSel[sortedSel.length - 1];
  const selSet = new Set(sortedSel);

  const groupedMap = new Map();
  state.productGroups.forEach(pg => {
    const tier = pg.tier || (pg.brand.toLowerCase().includes('huda') ? 'Mainstream' : 'Premium');
    groupedMap.set(pg.id, {
      product_group_id: pg.id,
      brand: pg.brand,
      tier: tier,
      group_name: pg.group_name,
      display_order: pg.display_order,
      kv_paid_qty: 0,
      kv_free_qty: 0,
      dms_order_qty: 0,
      prev_balance: 0,
      period_balance: 0,
      total_balance: 0
    });
  });

  state.reconcileRowsAll.forEach(r => {
    if (!groupedMap.has(r.product_group_id)) return;
    const item = groupedMap.get(r.product_group_id);

    if (selSet.has(r.month_date)) {
      item.kv_paid_qty += Number(r.kv_paid_qty || 0);
      item.kv_free_qty += Number(r.kv_free_qty || 0);
      item.dms_order_qty += Number(r.dms_order_qty || 0);
      item.period_balance += -Number(r.monthly_diff || 0);
    }
    if (r.month_date < firstSelMonth) {
      item.prev_balance += -Number(r.monthly_diff || 0);
    }
    if (r.month_date < firstSelMonth || selSet.has(r.month_date)) {
      item.total_balance += -Number(r.monthly_diff || 0);
    }
  });

  const myRep = getActiveSalesRepId();
  if (myRep && myRep !== 'ALL') {
    state.transfers.filter(t => t.status === 'APPROVED').forEach(t => {
      const item = groupedMap.get(t.product_group_id), m = String(t.month_date).slice(0, 10);
      const d = t.from_rep_id === myRep ? -Number(t.quantity) : t.to_rep_id === myRep ? Number(t.quantity) : 0;
      if (!item || !d) return;
      item.transfer_net = (item.transfer_net || 0) + d;
      if (selSet.has(m)) { item.kv_paid_qty += d; item.period_balance += d; }
      if (m < firstSelMonth) item.prev_balance += d;
      if (m < firstSelMonth || selSet.has(m)) item.total_balance += d;
    });
  }
  const activeRows = Array.from(groupedMap.values())
    .filter(r => r.kv_paid_qty > 0 || r.kv_free_qty > 0 || r.dms_order_qty > 0 || r.prev_balance !== 0 || r.total_balance !== 0)
    .sort((a, b) => a.display_order - b.display_order);

  const premiumRows = activeRows.filter(r => r.tier === 'Premium');
  const mainstreamRows = activeRows.filter(r => r.tier === 'Mainstream');

  let totKvPaid = 0, totKvFree = 0, totDms = 0, totPrev = 0, totPeriod = 0, totTotal = 0, totPos = 0, totNeg = 0;
  activeRows.forEach(r => {
    totKvPaid += r.kv_paid_qty;
    totKvFree += r.kv_free_qty;
    totDms += r.dms_order_qty;
    totPrev += r.prev_balance;
    totPeriod += r.period_balance;
    totTotal += r.total_balance;
    if (r.total_balance > 0) totPos += r.total_balance; else totNeg += -r.total_balance;
  });

  const tbody = document.getElementById('reconcileCompactBody');
  const tfoot = document.getElementById('reconcileCompactFoot');

  if (activeRows.length === 0) {
    tbody.innerHTML = `<tr><td colspan="5" class="py-8 text-center text-xs text-slate-400">Không có phát sinh sản lượng trong các tháng đã chọn.</td></tr>`;
    tfoot.innerHTML = '';
  } else {
    const renderSection = (title, headerClass, rowTintClass, accentDot, list) => {
      if (list.length === 0) return '';
      let sKv = 0, sDms = 0, sPrev = 0, sTot = 0;
      list.forEach(x => { sKv += x.kv_paid_qty; sDms += x.dms_order_qty; sPrev += x.prev_balance; sTot += x.total_balance; });

      const headerRow = `
        <tr class="${headerClass}">
          <td class="py-2 px-2.5 font-extrabold text-[11px] uppercase tracking-wider">${title}</td>
          <td class="py-2 px-1.5 text-right font-extrabold text-[11px] tabular-nums">${fmtNum(sKv)}</td>
          <td class="py-2 px-1.5 text-right font-extrabold text-[11px] tabular-nums">${fmtNum(sDms)}</td>
          <td class="py-2 px-1.5 text-right font-extrabold text-[11px] tabular-nums">${formatBalance(sPrev)}</td>
          <td class="py-2 px-2 text-right font-extrabold text-[11px] tabular-nums">${formatBalance(sTot)}</td>
        </tr>
      `;

      const itemRows = list.map(r => {
        const rowId = `sku-row-${r.product_group_id}`;
        return `
          <tr onclick="toggleAccordion('${rowId}')" class="${rowTintClass} hover:brightness-95 cursor-pointer transition">
            <td class="py-2.5 px-2.5">
              <div class="font-bold text-slate-900 leading-snug flex items-center gap-1.5">
                <span class="w-1.5 h-1.5 rounded-full ${accentDot} shrink-0"></span>
                <span>${r.group_name}</span>
              </div>
              ${showPromoInline && r.kv_free_qty > 0
                ? `<span class="inline-flex items-center gap-1 text-[10px] font-bold text-amber-800 bg-amber-100 px-1.5 py-0.5 rounded mt-0.5 ml-3">🎁 Tặng 0đ: ${fmtNum(r.kv_free_qty)}</span>`
                : `<span class="text-[10px] text-slate-400 ml-3">${r.brand}${r.kv_free_qty > 0 ? ' • có 0đ' : ''}</span>`
              }
            </td>
            <td class="py-2.5 px-1.5 text-right font-bold text-slate-900 tabular-nums">${fmtNum(r.kv_paid_qty)}</td>
            <td class="py-2.5 px-1.5 text-right font-bold text-slate-700 tabular-nums">${fmtNum(r.dms_order_qty)}</td>
            <td class="py-2.5 px-1.5 text-right font-semibold tabular-nums ${balanceTextColor(r.prev_balance)}">${formatBalance(r.prev_balance)}</td>
            <td class="py-2.5 px-2 text-right font-extrabold tabular-nums ${balanceCellBg(r.total_balance)}">${formatBalance(r.total_balance)}</td>
          </tr>
          <tr id="${rowId}" class="hidden bg-slate-50/90">
            <td colspan="5" class="px-3 py-2 text-[11px] text-slate-600 border-t border-dashed border-slate-200">
              <div class="flex flex-wrap items-center justify-between gap-2">
                <span>Chênh lệch riêng kỳ chọn: <b class="${balanceTextColor(r.period_balance)}">${formatBalance(r.period_balance)}</b></span>
                ${r.transfer_net ? `<span class="bg-purple-100 text-purple-800 px-2 py-0.5 rounded font-semibold">Luân chuyển đã duyệt: ${r.transfer_net > 0 ? '+' : '-'}${fmtNum(Math.abs(r.transfer_net))}</span>` : ''}
                <span class="bg-amber-100 text-amber-900 px-2 py-0.5 rounded font-semibold">Xuất tặng 0đ Kiot: <b>${fmtNum(r.kv_free_qty)}</b></span>
              </div>
            </td>
          </tr>
        `;
      }).join('');

      return headerRow + itemRows;
    };

    tbody.innerHTML =
      renderSection('★ PREMIUM', 'bg-indigo-900 text-indigo-50', 'bg-indigo-50/35 border-l-4 border-l-indigo-600', 'bg-indigo-600', premiumRows) +
      renderSection('● MAINSTREAM', 'bg-amber-800 text-amber-50', 'bg-amber-50/35 border-l-4 border-l-amber-500', 'bg-amber-500', mainstreamRows);

    tfoot.innerHTML = `
      <tr>
        <td class="py-3 px-2.5 uppercase text-[11px]">Tổng cộng tất cả</td>
        <td class="py-3 px-1.5 text-right tabular-nums">${fmtNum(totKvPaid)}</td>
        <td class="py-3 px-1.5 text-right tabular-nums text-amber-300">${fmtNum(totDms)}</td>
        <td class="py-3 px-1.5 text-right tabular-nums ${totPrev > 0 ? 'text-emerald-300' : totPrev < 0 ? 'text-rose-300' : 'text-slate-300'}">${formatBalance(totPrev)}</td>
        <td class="py-3 px-2 text-right tabular-nums text-sm ${totTotal > 0 ? 'bg-emerald-800 text-emerald-200' : totTotal < 0 ? 'bg-rose-900 text-rose-200' : ''}">${formatBalance(totTotal)}</td>
      </tr>
    `;
  }

  const freeTotal = state.kvLinesSelected.filter(l => l.is_free_gift).reduce((s, l) => s + Number(l.quantity), 0);
  const voucherTotal = state.dmsLinesSelected.filter(l => l.is_posm_voucher && l.order_type === 'Order').reduce((s, l) => s + Number(l.quantity), 0);

  document.getElementById('kpi-kvPaid').innerText = fmtNum(totKvPaid);
  document.getElementById('kpi-dmsOrder').innerText = fmtNum(totDms);
  document.getElementById('kpi-prevDiff').innerText = formatBalance(totPrev);
  document.getElementById('kpi-monthDiff').innerText = formatBalance(totPeriod);
  document.getElementById('kpi-freeBanner').innerText = fmtNum(freeTotal);
  document.getElementById('kpi-voucherBanner').innerText = fmtNum(voucherTotal);

  const totEl = document.getElementById('kpi-totalDiff');
  totEl.innerText = formatBalance(totTotal);
  totEl.className = `text-3xl sm:text-4xl font-extrabold tracking-tight ${totTotal > 0 ? 'text-emerald-300' : totTotal < 0 ? 'text-rose-300' : 'text-white'}`;

  document.getElementById('kpi-totalLabel').innerText =
    (totPos === 0 && totNeg === 0) ? 'Đã khớp 100% số bán Kiot và số key DMS'
    : `Chưa key DMS: ${fmtNum(totPos)} • Key dư: ${fmtNum(totNeg)} (thùng/két)`;
}

// =========================================================================
// TAB 2: KIOT
// =========================================================================
function renderKvCustomersTab() {
  const kw = document.getElementById('searchKvCust').value.toLowerCase().trim();
  const custMap = new Map(state.kvCustomers.map(c => [c.kv_customer_code, c]));
  const repMap = new Map(state.salesReps.map(r => [r.id, r.full_name]));

  const agg = new Map();
  state.kvLinesSelected.filter(l => listTier === 'ALL' || getLineTier('KIOTVIET', l) === listTier).forEach(line => {
    if (!agg.has(line.kv_customer_code)) agg.set(line.kv_customer_code, { paid: 0, free: 0, lines: [] });
    const entry = agg.get(line.kv_customer_code);
    if (line.is_free_gift) entry.free += Number(line.quantity);
    else entry.paid += Number(line.quantity);
    entry.lines.push(line);
  });

  const list = Array.from(agg.entries()).filter(([code]) => {
    const c = custMap.get(code) || {};
    return !kw || code.toLowerCase().includes(kw) || (c.kv_customer_name || '').toLowerCase().includes(kw) || (c.phone || '').includes(kw);
  }).sort((a, b) => b[1].paid - a[1].paid);

  const tbody = document.getElementById('kvCustomersTableBody');
  const tfoot = document.getElementById('kvCustomersTableFoot');

  if (list.length === 0) {
    tbody.innerHTML = `<tr><td colspan="3" class="py-8 text-center text-xs text-slate-400">Không có điểm bán phát sinh trong kỳ chọn.</td></tr>`;
    tfoot.innerHTML = '';
    return;
  }

  let sumPaid = 0, sumFree = 0;
  tbody.innerHTML = list.map(([code, data]) => {
    sumPaid += data.paid;
    sumFree += data.free;
    const c = custMap.get(code) || { kv_customer_name: code };
    const repName = repMap.get(c.sales_rep_id) || 'Chưa gán sale';

    const byMonth = {};
    data.lines.forEach(h => {
      const m = h.sale_month.slice(0, 7);
      if (!byMonth[m]) byMonth[m] = [];
      const existing = byMonth[m].find(x => x.name === h.raw_product_name && x.isFree === h.is_free_gift);
      if (existing) existing.qty += Number(h.quantity);
      else byMonth[m].push({ name: h.raw_product_name, isFree: h.is_free_gift, qty: Number(h.quantity) });
    });

    const detId = `kv-row-${code}`;
    return `
      <tr onclick="toggleAccordion('${detId}')" class="hover:bg-slate-50 active:bg-slate-100 cursor-pointer transition">
        <td class="py-2.5 px-2.5">
          <div class="font-bold text-slate-900 leading-snug line-clamp-2">${esc(c.kv_customer_name)}</div>
          <div class="text-[10px] text-slate-400 mt-0.5">${code} • <span class="text-emerald-700 font-medium">${esc(repName)}</span></div>
        </td>
        <td class="py-2.5 px-1.5 text-right font-extrabold text-slate-900 tabular-nums">${fmtNum(data.paid)}</td>
        <td class="py-2.5 px-2 text-right font-extrabold tabular-nums bg-amber-50 text-amber-700">${data.free > 0 ? `+${fmtNum(data.free)}` : '-'}</td>
      </tr>
      <tr id="${detId}" class="hidden bg-slate-50">
        <td colspan="3" class="p-3 border-t border-dashed border-slate-200 space-y-2">
          ${Object.entries(byMonth).sort().reverse().map(([m, items]) => `
            <div class="bg-white p-2 rounded-xl border border-slate-200 text-[11px] space-y-1">
              <div class="font-bold text-emerald-800 border-b pb-1 flex justify-between gap-2"><span>Tháng ${m}</span><span class="tabular-nums">Tổng: ${fmtNum(items.filter(i => !i.isFree).reduce((a, i) => a + i.qty, 0))}${items.some(i => i.isFree) ? ` • 🎁 +${fmtNum(items.filter(i => i.isFree).reduce((a, i) => a + i.qty, 0))}` : ''}</span></div>
              ${items.map(it => it.isFree ? `
                <div class="flex justify-between items-center gap-2 py-1 px-2 rounded-lg bg-amber-50 border border-amber-200/80 text-amber-900">
                  <span class="font-semibold">🎁 ${esc(it.name)} <span class="text-[10px] bg-amber-200/80 px-1.5 py-0.2 rounded font-bold">TẶNG 0Đ</span></span>
                  <span class="font-extrabold text-amber-800 shrink-0 tabular-nums">+${fmtNum(it.qty)}</span>
                </div>
              ` : `
                <div class="flex justify-between gap-2 py-0.5 px-1">
                  <span class="text-slate-700">${esc(it.name)}</span>
                  <span class="font-bold text-slate-900 shrink-0 tabular-nums">${fmtNum(it.qty)}</span>
                </div>
              `).join('')}
            </div>
          `).join('')}
        </td>
      </tr>
    `;
  }).join('');

  const trNetKv = getTransferNet(listTier);
  tfoot.innerHTML = `
    <tr>
      <td class="py-3 px-2.5 uppercase text-[11px]">Tổng cộng (${list.length} điểm bán)</td>
      <td class="py-3 px-1.5 text-right tabular-nums">${fmtNum(sumPaid)}</td>
      <td class="py-3 px-2 text-right tabular-nums text-amber-300">${sumFree > 0 ? `+${fmtNum(sumFree)}` : '0'}</td>
    </tr>
  ` + (trNetKv ? `
    <tr class="bg-purple-900 text-purple-100 text-[11px] font-semibold">
      <td class="py-2 px-2.5">Luân chuyển số đã duyệt (kỳ chọn)</td>
      <td class="py-2 px-1.5 text-right tabular-nums">${formatBalance(trNetKv)}</td>
      <td></td>
    </tr>
    <tr>
      <td class="py-3 px-2.5 uppercase text-[11px]">Tổng sau luân chuyển</td>
      <td class="py-3 px-1.5 text-right tabular-nums">${fmtNum(sumPaid + trNetKv)}</td>
      <td></td>
    </tr>
  ` : '');
}

// =========================================================================
// TAB 3: DMS
// =========================================================================
function renderDmsCustomersTab() {
  const kw = document.getElementById('searchDmsCust').value.toLowerCase().trim();
  const outMap = new Map(state.dmsOutlets.map(o => [o.dms_outlet_code, o]));
  const repMap = new Map(state.salesReps.map(r => [r.id, r.full_name]));

  const agg = new Map();
  state.dmsLinesSelected.filter(l => l.order_type === 'Order' && (listTier === 'ALL' || (!l.is_posm_voucher && getLineTier('DMS', l) === listTier))).forEach(line => {
    if (!agg.has(line.dms_outlet_code)) agg.set(line.dms_outlet_code, { beerQty: 0, lines: [] });
    const entry = agg.get(line.dms_outlet_code);
    if (!line.is_posm_voucher) entry.beerQty += Number(line.quantity);
    entry.lines.push(line);
  });

  const list = Array.from(agg.entries()).filter(([code]) => {
    const o = outMap.get(code) || {};
    return !kw || code.toLowerCase().includes(kw) || (o.dms_outlet_name || '').toLowerCase().includes(kw);
  }).sort((a, b) => b[1].beerQty - a[1].beerQty);

  const tbody = document.getElementById('dmsCustomersTableBody');
  const tfoot = document.getElementById('dmsCustomersTableFoot');

  if (list.length === 0) {
    tbody.innerHTML = `<tr><td colspan="2" class="py-8 text-center text-xs text-slate-400">Không tìm thấy Outlet DMS trong kỳ chọn.</td></tr>`;
    tfoot.innerHTML = '';
    return;
  }

  let sumBeer = 0;
  tbody.innerHTML = list.map(([code, data]) => {
    sumBeer += data.beerQty;
    const o = outMap.get(code) || { dms_outlet_name: code };
    const repName = repMap.get(o.sales_rep_id) || 'Chưa gán sale';

    const byMonth = {};
    data.lines.forEach(h => {
      const m = h.order_month.slice(0, 7);
      if (!byMonth[m]) byMonth[m] = [];
      const existing = byMonth[m].find(x => x.name === h.raw_product_name && x.isVoucher === h.is_posm_voucher);
      if (existing) existing.qty += Number(h.quantity);
      else byMonth[m].push({ name: h.raw_product_name, isVoucher: h.is_posm_voucher, qty: Number(h.quantity) });
    });

    const detId = `dms-row-${code}`;
    return `
      <tr onclick="toggleAccordion('${detId}')" class="hover:bg-slate-50 active:bg-slate-100 cursor-pointer transition">
        <td class="py-2.5 px-2.5">
          <div class="font-bold text-slate-900 leading-snug line-clamp-2">${esc(o.dms_outlet_name)}</div>
          <div class="text-[10px] text-slate-400 mt-0.5">${code} • <span class="text-slate-600 font-medium">${esc(repName)}</span></div>
        </td>
        <td class="py-2.5 px-2 text-right font-extrabold text-emerald-700 tabular-nums bg-emerald-50/50">${fmtNum(data.beerQty)}</td>
      </tr>
      <tr id="${detId}" class="hidden bg-slate-50">
        <td colspan="2" class="p-3 border-t border-dashed border-slate-200 space-y-2">
          ${Object.entries(byMonth).sort().reverse().map(([m, items]) => `
            <div class="bg-white p-2 rounded-xl border border-slate-200 text-[11px] space-y-1">
              <div class="font-bold text-emerald-800 border-b pb-1 flex justify-between gap-2"><span>Tháng ${m}</span><span class="tabular-nums">Tổng: ${fmtNum(items.filter(i => !i.isVoucher).reduce((a, i) => a + i.qty, 0))}${items.some(i => i.isVoucher) ? ` • 🎟️ ${fmtNum(items.filter(i => i.isVoucher).reduce((a, i) => a + i.qty, 0))} suất` : ''}</span></div>
              ${items.map(it => it.isVoucher ? `
                <div class="flex justify-between items-center gap-2 py-1 px-2 rounded-lg bg-purple-50 border border-purple-200 text-purple-900">
                  <span class="font-semibold">🎟️ ${esc(it.name)} <span class="text-[10px] bg-purple-200/80 px-1.5 py-0.2 rounded font-bold">VOUCHER</span></span>
                  <span class="font-extrabold text-purple-800 shrink-0 tabular-nums">${fmtNum(it.qty)} suất</span>
                </div>
              ` : `
                <div class="flex justify-between gap-2 py-0.5 px-1">
                  <span class="text-slate-700">${esc(it.name)}</span>
                  <span class="font-bold text-slate-900 shrink-0 tabular-nums">${fmtNum(it.qty)}</span>
                </div>
              `).join('')}
            </div>
          `).join('')}
        </td>
      </tr>
    `;
  }).join('');

  tfoot.innerHTML = `
    <tr>
      <td class="py-3 px-2.5 uppercase text-[11px]">Tổng cộng (${list.length} outlet)</td>
      <td class="py-3 px-2 text-right tabular-nums bg-emerald-800 text-emerald-200">${fmtNum(sumBeer)}</td>
    </tr>
  `;
}

// =========================================================================
// TAB 4: GHÉP KH
// =========================================================================
function getActiveSalesRepId() {
  if (currentUser?.role === 'SALE') return currentUser.sales_rep_id;
  return document.getElementById('filterSalesRep').value;
}

function renderCustomerMatchTab() {
  const selectedRep = getActiveSalesRepId();
  const linkedDmsNow = new Set(state.customerLinks.map(l => l.dms_outlet_code));
  const sugs = state.suggestions.filter(s => (selectedRep === 'ALL' || s.sales_rep_id === selectedRep) && !linkedDmsNow.has(s.dms_outlet_code));
  document.getElementById('sugCountBadge').innerText = sugs.length;
  const sugContainer = document.getElementById('suggestionsContainer');

  if (sugs.length === 0) {
    sugContainer.innerHTML = `<p class="text-xs text-slate-400 text-center py-2">Không còn gợi ý nào cần duyệt. Bấm <b>Ghép tay</b> nếu muốn nối thêm quán.</p>`;
  } else {
    sugContainer.innerHTML = sugs.slice(0, 15).map(s => `
      <div class="p-3 rounded-xl border border-slate-200 bg-slate-50/80 space-y-2.5">
        <div class="grid grid-cols-1 sm:grid-cols-2 gap-2 text-xs">
          <div class="bg-white p-2.5 rounded-lg border border-slate-200">
            <div class="flex items-center justify-between text-[10px] font-bold text-slate-400">
              <span>KIOT • ${s.kv_customer_code}</span>
              <span>${esc(s.sales_rep_name || '')}</span>
            </div>
            <p class="font-bold text-slate-900 mt-0.5">${esc(s.kv_customer_name)}</p>
          </div>
          <div class="bg-white p-2.5 rounded-lg border border-emerald-200">
            <div class="flex items-center justify-between text-[10px] font-bold text-emerald-600">
              <span>DMS • ${s.dms_outlet_code}</span>
              <span class="bg-amber-100 text-amber-800 px-1.5 py-0.5 rounded">Giống ${s.similarity_score}%</span>
            </div>
            <p class="font-bold text-emerald-900 mt-0.5">${esc(s.dms_outlet_name)}</p>
          </div>
        </div>

        <div class="grid grid-cols-2 gap-2">
          <button onclick="rejectCustomerSuggestion('${s.kv_customer_code}', '${s.dms_outlet_code}')" class="bg-white hover:bg-rose-50 active:scale-98 text-rose-600 border border-rose-200 text-xs font-bold py-2 rounded-xl flex items-center justify-center gap-1.5 transition">
            <i data-lucide="x-circle" class="w-4 h-4"></i> Từ Chối (Khác Quán)
          </button>
          <button onclick="confirmCustomerLink('${s.kv_customer_code}', '${s.dms_outlet_code}', ${s.similarity_score}, 'AUTO_NAME')" class="bg-emerald-700 hover:bg-emerald-800 active:scale-98 text-white text-xs font-bold py-2 rounded-xl flex items-center justify-center gap-1.5 transition">
            <i data-lucide="check-circle-2" class="w-4 h-4"></i> Xác Nhận Là 1
          </button>
        </div>
      </div>
    `).join('');
  }

  renderLinkedCustomersComparison();
}

async function confirmCustomerLink(kvCode, dmsCode, score, method, ignoreLinkId) {
  // 1 outlet DMS chỉ được ghép với 1 quán Kiot (tránh tính trùng số key DMS)
  const clash = state.customerLinks.find(l => l.dms_outlet_code === dmsCode && l.kv_customer_code !== kvCode && l.id !== ignoreLinkId);
  if (clash) {
    const other = state.kvCustomers.find(c => c.kv_customer_code === clash.kv_customer_code);
    alert(`Outlet DMS này đã được ghép với quán Kiot "${other ? other.kv_customer_name : clash.kv_customer_code}". Hãy hủy ghép quán đó trước.`);
    return false;
  }
  const { error } = await supabaseClient.from('customer_links').upsert({
    kv_customer_code: kvCode, dms_outlet_code: dmsCode, match_score: score, match_method: method
  }, { onConflict: 'kv_customer_code' });
  if (error) {
    alert(error.code === '23505' ? 'Outlet DMS này đã được ghép với quán khác!' : 'Lỗi ghép khách hàng: ' + error.message);
    return false;
  }
  await onFilterChange();
  return true;
}

async function rejectCustomerSuggestion(kvCode, dmsCode) {
  const { error } = await supabaseClient.from('rejected_customer_suggestions').upsert({
    kv_customer_code: kvCode, dms_outlet_code: dmsCode
  });
  if (error) {
    state.suggestions = state.suggestions.filter(s => !(s.kv_customer_code === kvCode && s.dms_outlet_code === dmsCode));
    renderCustomerMatchTab();
    lucide.createIcons();
    return;
  }
  await onFilterChange();
}

async function unlinkCustomer(linkId) {
  if (!confirm('Hủy liên kết cặp khách hàng này?')) return;
  await supabaseClient.from('customer_links').delete().eq('id', linkId);
  await onFilterChange();
}

function openManualLinkModal(editLink = null) {
  const selectedRep = getActiveSalesRepId();
  const linkedKv = new Set(state.customerLinks.map(l => l.kv_customer_code));
  const linkedDms = new Set(state.customerLinks.map(l => l.dms_outlet_code));

  const kvSel = document.getElementById('manualKvSelect');
  const dmsSel = document.getElementById('manualDmsSelect');
  const titleEl = document.getElementById('manualLinkModalTitle');
  document.getElementById('editingLinkId').value = editLink ? editLink.id : '';

  if (editLink) {
    titleEl.innerText = 'Đổi Outlet DMS Ghép Với Quán Này';
    const curKv = state.kvCustomers.find(c => c.kv_customer_code === editLink.kv_customer_code);
    kvSel.innerHTML = `<option value="${editLink.kv_customer_code}">[${esc(editLink.kv_customer_code)}] ${esc(curKv ? curKv.kv_customer_name : editLink.kv_customer_code)}</option>`;
    kvSel.disabled = true;

    const repFilter = curKv?.sales_rep_id || selectedRep;
    const availDms = state.dmsOutlets.filter(o =>
      (o.dms_outlet_code === editLink.dms_outlet_code || !linkedDms.has(o.dms_outlet_code)) &&
      (repFilter === 'ALL' || o.sales_rep_id === repFilter)
    );
    dmsSel.innerHTML = availDms.map(o => `<option value="${o.dms_outlet_code}" ${o.dms_outlet_code === editLink.dms_outlet_code ? 'selected' : ''}>[${esc(o.dms_outlet_code)}] ${esc(o.dms_outlet_name)}</option>`).join('');
  } else {
    titleEl.innerText = 'Ghép Thủ Công Khách Hàng 2 Bên';
    kvSel.disabled = false;
    const availKv = state.kvCustomers.filter(c => !linkedKv.has(c.kv_customer_code) && (selectedRep === 'ALL' || c.sales_rep_id === selectedRep));
    const availDms = state.dmsOutlets.filter(o => !linkedDms.has(o.dms_outlet_code) && (selectedRep === 'ALL' || o.sales_rep_id === selectedRep));

    kvSel.innerHTML = availKv.map(c => `<option value="${c.kv_customer_code}">[${esc(c.kv_customer_code)}] ${esc(c.kv_customer_name)}</option>`).join('');
    dmsSel.innerHTML = availDms.map(o => `<option value="${o.dms_outlet_code}">[${esc(o.dms_outlet_code)}] ${esc(o.dms_outlet_name)}</option>`).join('');
  }

  document.getElementById('manualLinkModal').classList.remove('hidden');
}

async function saveManualLink() {
  const editLinkId = document.getElementById('editingLinkId').value;
  const kvCode = document.getElementById('manualKvSelect').value;
  const dmsCode = document.getElementById('manualDmsSelect').value;
  if (!kvCode || !dmsCode) return;

  // Đổi quán ghép: upsert theo kv_customer_code sẽ thay outlet DMS của đúng dòng cũ, không cần xóa trước
  const ok = await confirmCustomerLink(kvCode, dmsCode, 100, 'MANUAL', editLinkId || null);
  if (ok) closeModal('manualLinkModal');
}

function renderLinkedCustomersComparison() {
  const kw = document.getElementById('searchLinkedCust').value.toLowerCase().trim();
  const selectedRep = getActiveSalesRepId();
  const kvMap = new Map(state.kvCustomers.map(c => [c.kv_customer_code, c]));
  const dmsMap = new Map(state.dmsOutlets.map(o => [o.dms_outlet_code, o]));

  const skuInfoMap = new Map();
  state.skuMappings.forEach(m => {
    const grp = state.productGroups.find(g => g.id === m.product_group_id);
    if (grp) {
      const tier = grp.tier || (grp.brand.toLowerCase().includes('huda') ? 'Mainstream' : 'Premium');
      skuInfoMap.set(`${m.source_system}_${m.raw_code}`, { group_name: grp.group_name, tier });
    }
  });

  const tbody = document.getElementById('linkedComparisonTableBody');
  const tfoot = document.getElementById('linkedComparisonTableFoot');

  const filteredLinks = state.customerLinks.filter(l => {
    const kv = kvMap.get(l.kv_customer_code) || {};
    const dms = dmsMap.get(l.dms_outlet_code) || {};
    const repId = kv.sales_rep_id || dms.sales_rep_id;
    if (selectedRep !== 'ALL' && repId !== selectedRep) return false;
    return !kw || (kv.kv_customer_name || '').toLowerCase().includes(kw) || (dms.dms_outlet_name || '').toLowerCase().includes(kw);
  });

  if (filteredLinks.length === 0) {
    tbody.innerHTML = `<tr><td colspan="4" class="py-8 text-center text-xs text-slate-400">Chưa có cặp quán nào được ghép cho sale này.</td></tr>`;
    tfoot.innerHTML = '';
    return;
  }

  let totKv = 0, totDms = 0, totBal = 0;

  // Gom dòng theo khách/outlet một lần (tránh lọc lại toàn bộ dòng cho từng cặp quán)
  const kvByCust = new Map(), dmsByOutlet = new Map();
  state.kvLinesSelected.forEach(x => {
    if (x.is_free_gift) return;
    if (!kvByCust.has(x.kv_customer_code)) kvByCust.set(x.kv_customer_code, []);
    kvByCust.get(x.kv_customer_code).push(x);
  });
  state.dmsLinesSelected.forEach(x => {
    if (x.order_type !== 'Order' || x.is_posm_voucher) return;
    if (!dmsByOutlet.has(x.dms_outlet_code)) dmsByOutlet.set(x.dms_outlet_code, []);
    dmsByOutlet.get(x.dms_outlet_code).push(x);
  });

  tbody.innerHTML = filteredLinks.map(l => {
    const kv = kvMap.get(l.kv_customer_code) || { kv_customer_name: l.kv_customer_code };
    const dms = dmsMap.get(l.dms_outlet_code) || { dms_outlet_name: l.dms_outlet_code };

    const skuMatrix = {};
    (kvByCust.get(l.kv_customer_code) || []).forEach(x => {
      const info = skuInfoMap.get(`KIOTVIET_${x.raw_product_code}`) || { group_name: x.raw_product_name, tier: x.raw_product_name.toLowerCase().includes('huda') ? 'Mainstream' : 'Premium' };
      if (matchTierFilter !== 'ALL' && info.tier !== matchTierFilter) return;
      if (!skuMatrix[info.group_name]) skuMatrix[info.group_name] = { kv: 0, dms: 0, tier: info.tier };
      skuMatrix[info.group_name].kv += Number(x.quantity);
    });

    (dmsByOutlet.get(l.dms_outlet_code) || []).forEach(x => {
      const info = skuInfoMap.get(`DMS_${x.raw_product_code}`) || { group_name: x.raw_product_name, tier: x.raw_product_name.toLowerCase().includes('huda') ? 'Mainstream' : 'Premium' };
      if (matchTierFilter !== 'ALL' && info.tier !== matchTierFilter) return;
      if (!skuMatrix[info.group_name]) skuMatrix[info.group_name] = { kv: 0, dms: 0, tier: info.tier };
      skuMatrix[info.group_name].dms += Number(x.quantity);
    });

    let sumKv = 0, sumDms = 0;
    Object.values(skuMatrix).forEach(v => { sumKv += v.kv; sumDms += v.dms; });
    const bal = sumKv - sumDms;
    let pos = 0, neg = 0;
    Object.values(skuMatrix).forEach(v => { const d = v.kv - v.dms; if (d > 0) pos += d; else neg += -d; });

    totKv += sumKv;
    totDms += sumDms;
    totBal += bal;

    const detId = `link-row-${l.id}`;
    const safeLinkJson = JSON.stringify({ id: l.id, kv_customer_code: l.kv_customer_code, dms_outlet_code: l.dms_outlet_code }).replace(/"/g, '&quot;');

    return `
      <tr onclick="toggleAccordion('${detId}')" class="hover:bg-slate-50 active:bg-slate-100 cursor-pointer transition">
        <td class="py-2.5 px-2.5">
          <div class="font-bold text-slate-900 leading-snug line-clamp-1">${esc(kv.kv_customer_name)}</div>
          <div class="text-[10px] text-emerald-700 font-medium line-clamp-1">&harr; ${esc(dms.dms_outlet_name)}</div>
          ${pos > 0 && neg > 0 ? `<div class="text-[10px] text-amber-700 font-semibold">Lệch từng SKU: chưa key ${fmtNum(pos)} • key dư ${fmtNum(neg)}</div>` : ''}
        </td>
        <td class="py-2.5 px-1.5 text-right font-bold text-slate-900 tabular-nums">${fmtNum(sumKv)}</td>
        <td class="py-2.5 px-1.5 text-right font-bold text-slate-700 tabular-nums">${fmtNum(sumDms)}</td>
        <td class="py-2.5 px-2 text-right font-extrabold tabular-nums ${balanceCellBg(bal)}">${formatBalance(bal)}</td>
      </tr>
      <tr id="${detId}" class="hidden bg-slate-50">
        <td colspan="4" class="p-3 border-t border-dashed border-slate-200 space-y-2">
          <div class="flex flex-wrap items-center justify-between gap-2 text-[10px]">
            <span class="font-bold text-slate-500 uppercase">Chi tiết SKU kỳ chọn (${matchTierFilter === 'ALL' ? 'Tất cả' : matchTierFilter}):</span>
            <div class="flex items-center gap-2">
              <button onclick="event.stopPropagation(); openManualLinkModal(${safeLinkJson})" class="bg-blue-50 text-blue-700 border border-blue-200 px-2 py-1 rounded-lg font-bold flex items-center gap-1">
                <i data-lucide="refresh-cw" class="w-3 h-3"></i> Đổi quán ghép
              </button>
              <button onclick="event.stopPropagation(); unlinkCustomer('${l.id}')" class="bg-rose-50 text-rose-600 border border-rose-200 px-2 py-1 rounded-lg font-bold flex items-center gap-1">
                <i data-lucide="unlink" class="w-3 h-3"></i> Hủy ghép
              </button>
            </div>
          </div>
          <div class="bg-white rounded-xl border border-slate-200 overflow-hidden">
            <table class="w-full text-[11px] border-collapse">
              <thead class="bg-slate-100 text-slate-600 font-bold">
                <tr>
                  <th class="py-1.5 px-2 text-left">Sản phẩm</th>
                  <th class="py-1.5 px-1.5 text-right">Kiot</th>
                  <th class="py-1.5 px-1.5 text-right">DMS</th>
                  <th class="py-1.5 px-2 text-right">Lệch</th>
                </tr>
              </thead>
              <tbody class="divide-y divide-slate-100">
                ${Object.keys(skuMatrix).length === 0
                  ? `<tr><td colspan="4" class="py-3 text-center text-slate-400">Không phát sinh nhóm ${matchTierFilter} trong kỳ này.</td></tr>`
                  : Object.entries(skuMatrix).map(([gName, val]) => {
                    const diffSku = val.kv - val.dms;
                    const tierDot = val.tier === 'Premium' ? 'text-indigo-700' : 'text-amber-700';
                    return `
                      <tr>
                        <td class="py-1.5 px-2 font-medium text-slate-800"><span class="${tierDot} font-bold mr-1">${val.tier === 'Premium' ? '★' : '●'}</span>${esc(gName)}</td>
                        <td class="py-1.5 px-1.5 text-right tabular-nums">${fmtNum(val.kv)}</td>
                        <td class="py-1.5 px-1.5 text-right tabular-nums">${fmtNum(val.dms)}</td>
                        <td class="py-1.5 px-2 text-right font-bold tabular-nums ${balanceTextColor(diffSku)}">${formatBalance(diffSku)}</td>
                      </tr>
                    `;
                  }).join('')}
              </tbody>
            </table>
          </div>
        </td>
      </tr>
    `;
  }).join('');

  // Phần chưa ghép (để tổng khớp với Tab Đối chiếu)
  const linkedKvSet = new Set(state.customerLinks.map(l => l.kv_customer_code));
  const linkedDmsSet = new Set(state.customerLinks.map(l => l.dms_outlet_code));
  let unKv = 0, unDms = 0;
  state.kvLinesSelected.forEach(x => {
    if (x.is_free_gift || linkedKvSet.has(x.kv_customer_code)) return;
    if (matchTierFilter !== 'ALL' && getLineTier('KIOTVIET', x) !== matchTierFilter) return;
    unKv += Number(x.quantity);
  });
  state.dmsLinesSelected.forEach(x => {
    if (x.order_type !== 'Order' || x.is_posm_voucher || linkedDmsSet.has(x.dms_outlet_code)) return;
    if (matchTierFilter !== 'ALL' && getLineTier('DMS', x) !== matchTierFilter) return;
    unDms += Number(x.quantity);
  });
  const trNetL = getTransferNet(matchTierFilter);

  tfoot.innerHTML = `
    <tr>
      <td class="py-3 px-2.5 uppercase text-[11px]">Tổng cộng (${filteredLinks.length} quán)</td>
      <td class="py-3 px-1.5 text-right tabular-nums">${fmtNum(totKv)}</td>
      <td class="py-3 px-1.5 text-right tabular-nums text-amber-300">${fmtNum(totDms)}</td>
      <td class="py-3 px-2 text-right tabular-nums ${totBal > 0 ? 'bg-emerald-800 text-emerald-200' : totBal < 0 ? 'bg-rose-900 text-rose-200' : ''}">${formatBalance(totBal)}</td>
    </tr>
  ` + ((unKv || unDms) ? `
    <tr class="bg-slate-700 text-slate-100 text-[11px] font-semibold">
      <td class="py-2 px-2.5">Chưa ghép quán</td>
      <td class="py-2 px-1.5 text-right tabular-nums">${fmtNum(unKv)}</td>
      <td class="py-2 px-1.5 text-right tabular-nums">${fmtNum(unDms)}</td>
      <td class="py-2 px-2 text-right tabular-nums">${formatBalance(unKv - unDms)}</td>
    </tr>
  ` : '') + (trNetL ? `
    <tr class="bg-purple-900 text-purple-100 text-[11px] font-semibold">
      <td class="py-2 px-2.5">Luân chuyển số đã duyệt (kỳ chọn)</td>
      <td class="py-2 px-1.5 text-right tabular-nums">${formatBalance(trNetL)}</td>
      <td></td>
      <td class="py-2 px-2 text-right tabular-nums">${formatBalance(trNetL)}</td>
    </tr>
  ` : '');
}

// =========================================================================
// TAB 5: 0Đ & KM
// =========================================================================
function renderPromoTab() {
  const custMap = new Map(state.kvCustomers.map(c => [c.kv_customer_code, c.kv_customer_name]));
  const outMap = new Map(state.dmsOutlets.map(o => [o.dms_outlet_code, o.dms_outlet_name]));
  const repMap = new Map(state.salesReps.map(r => [r.id, r.full_name]));

  const group = (lines, custKey, nameMap, dateKey) => {
    const g = new Map();
    lines.forEach(l => {
      const k = l.raw_product_name;
      if (!g.has(k)) g.set(k, { name: k, total: 0, shops: new Map() });
      const e = g.get(k), q = Number(l.quantity || 0), code = l[custKey];
      e.total += q;
      if (!e.shops.has(code)) e.shops.set(code, { name: nameMap.get(code) || code, qty: 0, rows: [] });
      const sh = e.shops.get(code);
      sh.qty += q;
      sh.rows.push({ date: l[dateKey], qty: q, rep: repMap.get(l.sales_rep_id) || '', note: l.combined_note || l.promotion_name || '' });
    });
    return Array.from(g.values()).sort((x, y) => y.total - x.total);
  };
  const detail = (e, color, plus) => Array.from(e.shops.values()).sort((x, y) => y.qty - x.qty).map(sh => `
    <div class="bg-white rounded-xl border border-slate-200 p-2 text-[11px]">
      <div class="flex justify-between gap-2 font-bold text-slate-900"><span>${esc(sh.name)}</span><span class="${color} tabular-nums shrink-0">${plus}${fmtNum(sh.qty)}</span></div>
      ${sh.rows.map(r => `<div class="flex justify-between gap-2 text-[10px] text-slate-500 mt-0.5"><span>${fmtDate(r.date)} • ${esc(r.rep)}${r.note ? ' • ' + esc(r.note) : ''}</span><span class="tabular-nums shrink-0">${plus}${fmtNum(r.qty)}</span></div>`).join('')}
    </div>`).join('');

  const freeLines = state.kvLinesSelected.filter(l => l.is_free_gift);
  const totalFree = freeLines.reduce((x, l) => x + Number(l.quantity), 0);
  document.getElementById('badge-kvFreeTotal').innerText = fmtNum(totalFree);
  const kvGroups = group(freeLines, 'kv_customer_code', custMap, 'sale_date');
  const kvFreeBody = document.getElementById('kvFreeTableBody');
  const kvFreeFoot = document.getElementById('kvFreeTableFoot');
  if (kvGroups.length === 0) {
    kvFreeBody.innerHTML = `<tr><td colspan="3" class="py-8 text-center text-xs text-slate-400">Không có hàng xuất 0đ trong kỳ chọn.</td></tr>`;
    kvFreeFoot.innerHTML = '';
  } else {
    kvFreeBody.innerHTML = kvGroups.map((e, i) => `
      <tr onclick="toggleAccordion('kvfree-${i}')" class="hover:bg-amber-50/40 cursor-pointer">
        <td class="py-2.5 px-2.5 font-bold text-amber-900">🎁 ${esc(e.name)}</td>
        <td class="py-2.5 px-2 text-right text-slate-500 tabular-nums">${e.shops.size}</td>
        <td class="py-2.5 px-2 text-right font-extrabold text-amber-700 tabular-nums bg-amber-50/80">+${fmtNum(e.total)}</td>
      </tr>
      <tr id="kvfree-${i}" class="hidden bg-slate-50"><td colspan="3" class="p-2.5 space-y-1.5">${detail(e, 'text-amber-700', '+')}</td></tr>`).join('');
    kvFreeFoot.innerHTML = `<tr><td colspan="2" class="py-3 px-2.5 uppercase text-[11px]">Tổng hàng tặng 0đ Kiot</td><td class="py-3 px-2 text-right tabular-nums text-amber-300">+${fmtNum(totalFree)}</td></tr>`;
  }

  const voucherLines = state.dmsLinesSelected.filter(l => l.is_posm_voucher && l.order_type === 'Order');
  const totalVouchers = voucherLines.reduce((x, l) => x + Number(l.quantity), 0);
  document.getElementById('badge-dmsVoucherTotal').innerText = fmtNum(totalVouchers);
  const vGroups = group(voucherLines, 'dms_outlet_code', outMap, 'ordered_date');
  
  const vBody = document.getElementById('dmsVoucherTableBody');
  const vFoot = document.getElementById('dmsVoucherTableFoot');
  if (vGroups.length === 0) {
    vBody.innerHTML = `<tr><td colspan="2" class="py-8 text-center text-xs text-slate-400">Không có voucher DMS trong kỳ chọn.</td></tr>`;
    vFoot.innerHTML = '';
  } else {
    vBody.innerHTML = vGroups.map((e, i) => `
      <tr onclick="toggleAccordion('vch-${i}')" class="hover:bg-purple-50/40 cursor-pointer">
        <td class="py-2.5 px-2.5"><div class="font-bold text-purple-900">🎟️ ${esc(e.name)}</div><div class="text-[10px] text-slate-400">${e.shops.size} quán nhận</div></td>
        <td class="py-2.5 px-2 text-right font-extrabold text-purple-700 tabular-nums bg-purple-50/80">${fmtNum(e.total)}</td>
      </tr>
      <tr id="vch-${i}" class="hidden bg-slate-50"><td colspan="2" class="p-2.5 space-y-1.5">${detail(e, 'text-purple-700', '')}</td></tr>`).join('');
    vFoot.innerHTML = `<tr><td class="py-3 px-2.5 uppercase text-[11px]">Tổng suất voucher trả NPP</td><td class="py-3 px-2 text-right tabular-nums text-purple-300">${fmtNum(totalVouchers)}</td></tr>`;
  }
}

// =========================================================================
// QUẢN LÝ MÃ SKU MỚI & NẠP EXCEL (ADMIN / SS)
// =========================================================================
function openSkuModal() {
  const container = document.getElementById('skuMappingList');
  container.innerHTML = state.skuMappings.filter(m => !isIgnoredSku(m.raw_code)).map(m => `
    <div class="p-3 rounded-xl border ${!m.product_group_id ? 'bg-amber-50 border-amber-300' : 'bg-slate-50 border-slate-200'} space-y-1.5">
      <div class="flex items-center justify-between text-xs">
        <span class="font-bold text-emerald-800">${m.source_system === 'KIOTVIET' ? 'KIOT' : m.source_system} • ${m.raw_code}</span>
      </div>
      <p class="text-xs text-slate-700 font-medium">${esc(m.raw_name)}</p>
      <select onchange="updateSkuGroup('${m.id}', this.value)" class="w-full bg-white border border-slate-300 rounded-lg px-2.5 py-1.5 text-xs font-semibold">
        <option value="">-- Chọn nhóm chuẩn --</option>
        ${state.productGroups.map(g => `<option value="${g.id}" ${g.id === m.product_group_id ? 'selected' : ''}>[${g.tier || 'Premium'}] ${g.group_name}</option>`).join('')}
      </select>
    </div>
  `).join('');
  document.getElementById('skuModal').classList.remove('hidden');
}

async function updateSkuGroup(mappingId, groupId) {
  await supabaseClient.from('sku_mappings').update({
    product_group_id: groupId || null, is_verified: Boolean(groupId)
  }).eq('id', mappingId);
  await refreshAllData();
}

function openUploadModal() { document.getElementById('uploadModal').classList.remove('hidden'); }
function closeModal(id) { document.getElementById(id).classList.add('hidden'); }

function logUpload(msg) {
  const box = document.getElementById('uploadLogBox');
  box.classList.remove('hidden');
  box.innerHTML += `<div>&gt; ${msg}</div>`;
  box.scrollTop = box.scrollHeight;
}

async function processExcelUploads() {
  const fileKv = document.getElementById('fileInputKv').files[0];
  const fileDms = document.getElementById('fileInputDms').files[0];
  if (!fileKv && !fileDms) return alert('Vui lòng chọn ít nhất 1 file Excel!');

  const btn = document.getElementById('btnProcessUpload');
  btn.disabled = true;
  document.getElementById('uploadLogBox').innerHTML = '';

  try {
    if (fileKv) await importKiotVietExcel(fileKv);
    if (fileDms) await importDmsExcel(fileDms);
    logUpload('HOÀN TẤT! Đang tải lại số liệu...');
    if (currentUser?.role === 'ADMIN') loadStorageUsage();
    await refreshAllData();
  } catch (err) {
    console.error(err);
    logUpload('LỖI: ' + err.message);
  } finally {
    btn.disabled = false;
  }
}

function parseExcelDate(val) {
  if (!val) return null;
  if (val instanceof Date) return val;
  if (typeof val === 'number') {
    // Số serial Excel -> lấy đúng giờ/phút/giây ghi trong file, không phụ thuộc múi giờ của SheetJS
    const u = new Date(Math.round((val - 25569) * 86400) * 1000);
    return new Date(u.getUTCFullYear(), u.getUTCMonth(), u.getUTCDate(), u.getUTCHours(), u.getUTCMinutes(), u.getUTCSeconds());
  }
  if (typeof val === 'string') {
    const m = val.trim().match(/^(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{4})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?)?$/);
    if (m) return new Date(+m[3], +m[2] - 1, +m[1], +(m[4] || 0), +(m[5] || 0), +(m[6] || 0));
  }
  const d = new Date(val);
  return isNaN(d.getTime()) ? null : d;
}

function findSalesRepIdByKvName(rawSeller) {
  if (!rawSeller) return null;
  const norm = rawSeller.trim().toLowerCase();
  for (const rep of state.salesReps) {
    if ((rep.kv_seller_names || []).some(n => n.trim().toLowerCase() === norm)) return rep.id;
    if (rep.phone && norm.includes(rep.phone)) return rep.id;
  }
  return null;
}

function findSalesRepIdByDmsName(rawCvtcsr) {
  if (!rawCvtcsr) return null;
  const norm = rawCvtcsr.trim().toLowerCase();
  const found = state.salesReps.find(r => r.dms_cvtcsr_name.trim().toLowerCase() === norm);
  return found ? found.id : null;
}

async function importKiotVietExcel(file) {
  logUpload(`Đọc Kiot: ${file.name}...`);
  await tick();
  const buf = await file.arrayBuffer();
  const wb = XLSX.read(buf, { type: 'array', cellDates: false });
  const rows = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { defval: null });
  if (rows.length && !('Mã hàng' in rows[0])) throw new Error('File Kiot sai định dạng (không có cột "Mã hàng").');
  logUpload(`Đang xử lý ${rows.length} dòng Kiot...`);
  await tick();

  const customersMap = new Map();
  const kvExistRep = new Map(state.kvCustomers.map(c => [c.kv_customer_code, c.sales_rep_id]));
  const noRepKv = new Map();
  let skippedKw = 0, skippedCancel = 0;
  const skippedNames = new Set();
  const newSkusMap = new Map();
  const lineCounter = new Map();
  const salesLines = [];
  const kvInvoiceCodes = new Set(); // mọi hóa đơn Carlsberg có trong file (kể cả đã hủy)

  for (const r of rows) {
    const nhomHang = String(r['Nhóm hàng'] || '').toLowerCase();
    const tenHang = String(r['Tên hàng'] || '').toLowerCase();
    const dvt = String(r['ĐVT'] || '').toLowerCase();
    if (KV_SKIP_NAME_PARTS.some(k => nhomHang.includes(k) || tenHang.includes(k)) || KV_SKIP_UNITS.includes(dvt)) continue;
    if (!CARLSBERG_KEYWORDS.some(k => nhomHang.includes(k) || tenHang.includes(k))) {
      skippedKw++; if (skippedNames.size < 8) skippedNames.add(String(r['Tên hàng'] || ''));
      continue;
    }
    const invCodeRaw = String(r['Mã hóa đơn'] || '').trim();
    if (invCodeRaw) kvInvoiceCodes.add(invCodeRaw);
    const stt = String(r['Trạng thái'] || '').toLowerCase();
    if (stt.includes('hủy') || stt.includes('huỷ')) { skippedCancel++; continue; }

    const dt = parseExcelDate(r['Thời gian']);
    if (!dt) continue;
    const saleMonth = `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}-01`;

    const repId = findSalesRepIdByKvName(r['Người bán']);
    const custCode = String(r['Mã khách hàng'] || 'KH_LE').trim();
    const custName = String(r['Tên khách hàng'] || 'Khách lẻ').trim();
    const rawCode = String(r['Mã hàng'] || '').trim();
    const rawProdName = String(r['Tên hàng'] || '').trim();
    const invoiceCode = String(r['Mã hóa đơn'] || '').trim();
    const sellingPrice = Number(r['Giá bán'] || 0);

    const keepRepKv = repId || customersMap.get(custCode)?.sales_rep_id || kvExistRep.get(custCode) || null;
    if (!repId) { const nm = String(r['Người bán'] || '(trống)'); noRepKv.set(nm, (noRepKv.get(nm) || 0) + 1); }
    customersMap.set(custCode, {
      kv_customer_code: custCode,
      kv_customer_name: custName,
      phone: r['Điện thoại'] ? String(r['Điện thoại']).replace(/\.0$/, '') : null,
      address: r['Địa chỉ (Khách hàng)'] || null,
      sales_rep_id: keepRepKv
    });

    if (!state.skuMappings.some(m => m.source_system === 'KIOTVIET' && m.raw_code === rawCode)) {
      newSkusMap.set(rawCode, { source_system: 'KIOTVIET', raw_code: rawCode, raw_name: rawProdName, is_verified: false });
    }

    const dupKey = `${invoiceCode}_${rawCode}_${sellingPrice}`;
    const idx = (lineCounter.get(dupKey) || 0) + 1;
    lineCounter.set(dupKey, idx);

    const noteParts = [r['Ghi chú hàng hóa'], r['Ghi chú']].filter(Boolean).map(s => String(s).trim());
    salesLines.push({
      invoice_code: invoiceCode,
      line_index: idx,
      sale_date: dt.toISOString(),
      sale_month: saleMonth,
      status: String(r['Trạng thái'] || 'Hoàn thành'),
      sales_rep_id: keepRepKv,
      raw_seller_name: r['Người bán'],
      kv_customer_code: custCode,
      raw_product_code: rawCode,
      raw_product_name: rawProdName,
      unit: r['ĐVT'] || null,
      quantity: Number(r['Số lượng'] || 0),
      unit_price: Number(r['Đơn giá'] || 0),
      discount_amount: Number(r['Giảm giá'] || 0),
      selling_price: sellingPrice,
      total_amount: Number(r['Thành tiền'] || 0),
      combined_note: [...new Set(noteParts)].join(' | ') || null
    });
  }

  logUpload(`Tìm thấy ${salesLines.length} dòng Carlsberg.`);
  if (skippedCancel) logUpload(`Bỏ ${skippedCancel} dòng hóa đơn đã hủy.`);
  if (skippedKw) logUpload(`⚠ Bỏ ${skippedKw} dòng không thuộc nhãn Carlsberg, vd: ${[...skippedNames].join('; ')}`);
  if (noRepKv.size) logUpload(`⚠ Chưa khớp sale với người bán: ${[...noRepKv].map(([n, c]) => `${n} (${c})`).join(', ')}`);
  if (customersMap.size > 0) {
    const { error } = await supabaseClient.from('kv_customers').upsert(Array.from(customersMap.values()), { onConflict: 'kv_customer_code' });
    if (error) throw error;
  }
  if (newSkusMap.size > 0) {
    await supabaseClient.from('sku_mappings').upsert(Array.from(newSkusMap.values()), { onConflict: 'source_system,raw_code' });
  }
  // Xóa dòng cũ của các hóa đơn có trong file: hóa đơn đã hủy/sửa sẽ không còn sót số cũ
  const invList = [...kvInvoiceCodes];
  if (invList.length) {
    logUpload(`Dọn dòng cũ của ${invList.length} hóa đơn có trong file...`);
    for (let i = 0; i < invList.length; i += 100) {
      const { error } = await supabaseClient.from('kv_sales_lines').delete().in('invoice_code', invList.slice(i, i + 100));
      if (error) throw error;
      await tick();
    }
  }
  for (let i = 0; i < salesLines.length; i += 500) {
    const { error } = await supabaseClient.from('kv_sales_lines').upsert(salesLines.slice(i, i + 500), {
      onConflict: 'invoice_code,raw_product_code,selling_price,line_index'
    });
    if (error) throw error;
    logUpload(`Kiot: đã lưu ${Math.min(i + 500, salesLines.length)}/${salesLines.length} dòng`);
    await tick();
  }
  logUpload(`Đã lưu xong Kiot!`);
}

async function importDmsExcel(file) {
  logUpload(`Đọc DMS: ${file.name}...`);
  await tick();
  const buf = await file.arrayBuffer();
  const wb = XLSX.read(buf, { type: 'array', cellDates: false });
  const sheetName = wb.SheetNames.includes('Detail') ? 'Detail' : wb.SheetNames[0];
  const rows = XLSX.utils.sheet_to_json(wb.Sheets[sheetName], { defval: null });
  if (rows.length && !('OutletCode' in rows[0])) throw new Error('File DMS sai định dạng (không có cột "OutletCode").');
  logUpload(`Đang xử lý ${rows.length} dòng DMS...`);
  await tick();

  const outletsMap = new Map();
  const dmsExistRep = new Map(state.dmsOutlets.map(o => [o.dms_outlet_code, o.sales_rep_id]));
  const noRepDms = new Map();
  let skippedCancel = 0;
  const statusSeen = new Set();
  const newSkusMap = new Map();
  const lineCounter = new Map();
  const dmsLines = [];
  const dmsOrderCodes = new Set(); // mọi đơn của NPP có trong file (kể cả đơn hủy)

  for (const r of rows) {
    if (String(r['DisCode'] || '').trim() !== DIS_CODE) continue;
    const ordCodeRaw = String(r['OrderCode'] || '').trim();
    if (ordCodeRaw) dmsOrderCodes.add(ordCodeRaw);
    const st = String(r['OrderStatus'] || '').toLowerCase();
    statusSeen.add(String(r['OrderStatus'] || ''));
    if (/cancel|reject|hủy|huỷ|từ chối/.test(st)) { skippedCancel++; continue; }
    const ordDt = parseExcelDate(r['OrderedDate']);
    if (!ordDt) continue;
    const delDt = parseExcelDate(r['DeliveriedDate']);
    const orderMonth = `${ordDt.getFullYear()}-${String(ordDt.getMonth() + 1).padStart(2, '0')}-01`;

    const repId = findSalesRepIdByDmsName(r['CVTCSR']);
    const outletCode = String(r['OutletCode'] || '').trim();
    const outletName = String(r['OutletName'] || '').trim();
    const rawBrand = String(r['Brand'] || '').trim();
    const rawCode = String(r['ProductCode'] || '').trim();
    const rawProdName = String(r['Product'] || '').trim();
    const orderCode = String(r['OrderCode'] || '').trim();
    const orderType = String(r['OrderType'] || 'Order').trim();

    const keepRepDms = repId || outletsMap.get(outletCode)?.sales_rep_id || dmsExistRep.get(outletCode) || null;
    if (!repId) { const nm = String(r['CVTCSR'] || '(trống)'); noRepDms.set(nm, (noRepDms.get(nm) || 0) + 1); }
    outletsMap.set(outletCode, {
      dms_outlet_code: outletCode,
      dms_outlet_name: outletName,
      channel: r['Channel'] || null,
      sub_channel: r['SubChannel'] || null,
      sales_rep_id: keepRepDms
    });

    if (rawBrand !== 'POSM' && !state.skuMappings.some(m => m.source_system === 'DMS' && m.raw_code === rawCode)) {
      newSkusMap.set(rawCode, {
        source_system: 'DMS', raw_code: rawCode, raw_group_code: r['GroupCode'] || null, raw_name: rawProdName, is_verified: false
      });
    }

    const dupKey = `${orderCode}_${rawCode}_${orderType}`;
    const idx = (lineCounter.get(dupKey) || 0) + 1;
    lineCounter.set(dupKey, idx);

    dmsLines.push({
      order_code: orderCode,
      line_index: idx,
      ordered_date: ordDt.toISOString(),
      delivered_date: delDt ? delDt.toISOString() : null,
      order_month: orderMonth,
      order_status: String(r['OrderStatus'] || ''),
      order_type: orderType,
      dis_code: DIS_CODE,
      sales_rep_id: keepRepDms,
      raw_cvtcsr: r['CVTCSR'],
      dms_outlet_code: outletCode,
      raw_brand: rawBrand,
      raw_product_code: rawCode,
      raw_group_code: r['GroupCode'] ? String(r['GroupCode']) : null,
      raw_product_name: rawProdName,
      quantity: Number(r['Quantity'] || 0),
      price: Number(r['Price'] || 0),
      revenue: Number(r['Revenue'] || 0),
      promotion_name: r['Promotion Name'] || null
    });
  }

  logUpload(`Tìm thấy ${dmsLines.length} dòng NPP Viet Bill.`);
  logUpload(`Trạng thái đơn trong file: ${[...statusSeen].join(', ') || '(trống)'}`);
  if (skippedCancel) logUpload(`Bỏ ${skippedCancel} dòng đơn hủy/từ chối.`);
  if (noRepDms.size) logUpload(`⚠ Chưa khớp sale với CVTCSR: ${[...noRepDms].map(([n, c]) => `${n} (${c})`).join(', ')}`);
  if (outletsMap.size > 0) {
    const { error } = await supabaseClient.from('dms_outlets').upsert(Array.from(outletsMap.values()), { onConflict: 'dms_outlet_code' });
    if (error) throw error;
  }
  if (newSkusMap.size > 0) {
    await supabaseClient.from('sku_mappings').upsert(Array.from(newSkusMap.values()), { onConflict: 'source_system,raw_code' });
  }
  const ordList = [...dmsOrderCodes];
  if (ordList.length) {
    logUpload(`Dọn dòng cũ của ${ordList.length} đơn DMS có trong file...`);
    for (let i = 0; i < ordList.length; i += 100) {
      const { error } = await supabaseClient.from('dms_order_lines').delete().in('order_code', ordList.slice(i, i + 100)).eq('dis_code', DIS_CODE);
      if (error) throw error;
      await tick();
    }
  }
  for (let i = 0; i < dmsLines.length; i += 500) {
    const { error } = await supabaseClient.from('dms_order_lines').upsert(dmsLines.slice(i, i + 500), {
      onConflict: 'order_code,raw_product_code,order_type,line_index'
    });
    if (error) throw error;
    logUpload(`DMS: đã lưu ${Math.min(i + 500, dmsLines.length)}/${dmsLines.length} dòng`);
    await tick();
  }
  logUpload(`Đã lưu xong DMS!`);
}

let listTier = 'ALL';
function getLineTier(src, line) {
  if (!state._tierMap) {
    state._tierMap = new Map();
    state.skuMappings.forEach(m => {
      const g = state.productGroups.find(x => x.id === m.product_group_id);
      if (g) state._tierMap.set(`${m.source_system}_${m.raw_code}`, g.tier || (g.brand.toLowerCase().includes('huda') ? 'Mainstream' : 'Premium'));
    });
  }
  return state._tierMap.get(`${src}_${line.raw_product_code}`) || (String(line.raw_product_name || '').toLowerCase().includes('huda') ? 'Mainstream' : 'Premium');
}
function renderTierBars() {
  const opts = [['ALL', 'Tổng', 'bg-slate-900 text-white', 'text-slate-700'], ['Premium', '★ Premium', 'bg-indigo-700 text-white', 'text-indigo-800'], ['Mainstream', '● Mainstream', 'bg-amber-600 text-white', 'text-amber-800']];
  const html = `<div class="grid grid-cols-3 bg-slate-200/80 p-1 rounded-xl text-[11px] sm:text-xs gap-1">${opts.map(([v, l, on, off]) => `<button onclick="setListTier('${v}')" class="py-1.5 rounded-lg ${listTier === v ? 'font-bold shadow-xs ' + on : 'font-semibold ' + off}">${l}</button>`).join('')}</div>`;
  ['kv', 'dms'].forEach(t => { const el = document.getElementById('tierBar-' + t); if (el) el.innerHTML = html; });
}
function setListTier(t) { listTier = t; renderTierBars(); renderActiveTab(); }
function fmtDate(iso) { if (!iso) return ''; const d = new Date(iso); return isNaN(d) ? String(iso).slice(0, 10) : d.toLocaleDateString('vi-VN'); }
// ===== DUNG LƯỢNG (ADMIN) =====
async function loadStorageUsage() {
  if (currentUser?.role !== 'ADMIN') return;
  let usedMB, est = false;
  const { data, error } = await supabaseClient.rpc('get_db_size');
  if (!error && data != null) usedMB = Number(data) / 1048576;
  else {
    const rs = await Promise.all(['kv_sales_lines', 'dms_order_lines'].map(t => supabaseClient.from(t).select('*', { count: 'exact', head: true })));
    usedMB = rs.reduce((a, r) => a + (r.count || 0), 0) * EST_BYTES_PER_ROW / 1048576; est = true;
  }
  state.storage = { usedMB, est };
  const pct = Math.min(100, Math.round(usedMB / DB_LIMIT_MB * 100)), c = 2 * Math.PI * 6;
  const color = pct >= 85 ? '#fb7185' : pct >= 60 ? '#fbbf24' : '#34d399';
  const btn = document.getElementById('btnStorageRing');
  btn.innerHTML = `<svg width="18" height="18" viewBox="0 0 16 16"><circle cx="8" cy="8" r="6" fill="none" stroke="rgba(255,255,255,.25)" stroke-width="2.5"/><circle cx="8" cy="8" r="6" fill="none" stroke="${color}" stroke-width="2.5" stroke-linecap="round" stroke-dasharray="${(c * pct / 100).toFixed(1)} ${c.toFixed(1)}" transform="rotate(-90 8 8)"/></svg>`;
  btn.title = `Dữ liệu: ${usedMB.toFixed(1)}/${DB_LIMIT_MB} MB`;
}
async function openStorageModal() {
  if (currentUser?.role !== 'ADMIN') return;
  document.getElementById('storageModal').classList.remove('hidden');
  await renderStorageModal();
}
async function renderStorageModal() {
  const sum = document.getElementById('storageSummary'), box = document.getElementById('storageMonths');
  sum.innerHTML = 'Đang tải...'; box.innerHTML = '';
  await loadStorageUsage();
  const u = state.storage.usedMB, pct = Math.min(100, u / DB_LIMIT_MB * 100);
  sum.innerHTML = `<div class="flex justify-between font-bold text-slate-700"><span>${u.toFixed(1)} / ${DB_LIMIT_MB} MB ${state.storage.est ? '(ước tính theo số dòng)' : ''}</span><span>${pct.toFixed(0)}%</span></div>
    <div class="h-2 bg-slate-200 rounded-full mt-1 overflow-hidden"><div class="h-2 ${pct >= 85 ? 'bg-rose-500' : pct >= 60 ? 'bg-amber-400' : 'bg-emerald-500'}" style="width:${pct}%"></div></div>
    ${state.storage.est ? '<p class="text-[10px] text-slate-400 mt-1">Chạy file setup_supabase.sql để hiện dung lượng thật.</p>' : ''}`;
  const rows = await Promise.all(state.availableMonths.map(async m => {
    const [a, b] = await Promise.all([
      supabaseClient.from('kv_sales_lines').select('*', { count: 'exact', head: true }).eq('sale_month', m),
      supabaseClient.from('dms_order_lines').select('*', { count: 'exact', head: true }).eq('order_month', m)]);
    return { m, kv: a.count || 0, dms: b.count || 0 };
  }));
  box.innerHTML = rows.map(r => `<div class="p-3 rounded-xl border border-slate-200 flex items-center justify-between gap-2 text-xs">
    <div><div class="font-bold text-slate-900">Tháng ${r.m.slice(5, 7)}/${r.m.slice(0, 4)}</div><div class="text-slate-500">Kiot ${fmtNum(r.kv)} dòng • DMS ${fmtNum(r.dms)} dòng</div></div>
    <button onclick="deleteMonthData('${r.m}')" class="text-rose-600 border border-rose-200 hover:bg-rose-50 px-3 py-1.5 rounded-lg font-bold">Xóa tháng</button></div>`).join('');
}
async function deleteMonthData(m) {
  if (currentUser?.role !== 'ADMIN') return;
  const lbl = `${m.slice(5, 7)}/${m.slice(0, 4)}`;
  if (!confirm(`XÓA toàn bộ dữ liệu Kiot + DMS tháng ${lbl}?\nKhông thể khôi phục.`)) return;
  if ((prompt(`Gõ XOA để xác nhận xóa tháng ${lbl}`) || '').trim().toUpperCase() !== 'XOA') return alert('Đã hủy, chưa xóa gì.');
  // Ưu tiên RPC (một transaction: xóa Kiot + DMS + luân chuyển của tháng đó)
  const rpc = await supabaseClient.rpc('delete_month_data', { p_month: m });
  if (rpc.error) {
    const missing = rpc.error.code === 'PGRST202' || /could not find|schema cache/i.test(rpc.error.message || '');
    if (!missing) return alert('Lỗi xóa: ' + rpc.error.message);
    // Chưa chạy file SQL -> xóa tuần tự (không atomic)
    const r1 = await supabaseClient.from('kv_sales_lines').delete().eq('sale_month', m);
    const r2 = await supabaseClient.from('dms_order_lines').delete().eq('order_month', m);
    if (r1.error || r2.error) return alert('Lỗi xóa: ' + (r1.error || r2.error).message);
    await supabaseClient.from('sale_transfers').delete().eq('month_date', m);
  }
  selectedMonths = selectedMonths.filter(x => x !== m);
  await refreshAllData();
  await renderStorageModal();
}

// ===== LUÂN CHUYỂN SỐ GIỮA SALE (CẦN SS/ADMIN DUYỆT) =====
function openSettings() { document.getElementById('settingsModal').classList.remove('hidden'); }
function menuGo(fn) { closeModal('settingsModal'); window[fn](); }
function refreshTrTo() {
  const from = document.getElementById('trFrom').value;
  document.getElementById('trTo').innerHTML = state.salesReps.filter(r => r.id !== from).map(r => `<option value="${r.id}">${r.full_name}</option>`).join('');
}
async function logTransfer(action, t, note) {
  const rep = id => state.salesReps.find(r => r.id === id)?.full_name || '?';
  const grp = state.productGroups.find(g => g.id === t.product_group_id)?.group_name || '';
  const m = String(t.month_date);
  await supabaseClient.from('sale_transfer_logs').insert({
    transfer_id: t.id ? String(t.id) : null, action, actor_id: String(currentUser.id), actor_name: currentUser.display_name, actor_role: currentUser.role,
    detail: `${rep(t.from_rep_id)} → ${rep(t.to_rep_id)} • ${grp} • ${t.quantity} • T${m.slice(5, 7)}/${m.slice(0, 4)}${t.reason ? ' • Lý do: ' + t.reason : ''}${note ? ' • ' + note : ''}`
  });
}
async function deleteTransfer(id) {
  if (!isManagerRole()) return;
  const t = state.transfers.find(x => x.id === id);
  if (!t) return;
  if (!confirm(t.status === 'APPROVED' ? 'Xóa luân chuyển ĐÃ DUYỆT?\nSố liệu của 2 sale sẽ trở về như chưa chuyển.' : 'Xóa yêu cầu này?')) return;
  const { error } = await supabaseClient.from('sale_transfers').delete().eq('id', id);
  if (error) return alert('Lỗi xóa: ' + error.message);
  await logTransfer('DELETE', t, 'Trạng thái lúc xóa: ' + t.status);
  await loadTransfers(); renderTransferList(); renderActiveTab();
}
async function openTransferLog() {
  if (!isManagerRole()) return;
  const box = document.getElementById('transferLogList');
  box.innerHTML = '<p class="text-xs text-slate-400 text-center py-3">Đang tải...</p>';
  document.getElementById('transferLogModal').classList.remove('hidden');
  const { data, error } = await supabaseClient.from('sale_transfer_logs').select('*').order('created_at', { ascending: false }).limit(300);
  if (error) { box.innerHTML = '<p class="text-xs text-rose-600 text-center py-3">Chưa có bảng sale_transfer_logs. Chạy lại file setup_supabase.sql.</p>'; return; }
  const rows = currentUser.role === 'ADMIN' ? data : data.filter(l => l.actor_role !== 'ADMIN');
  const ac = { CREATE: ['Tạo yêu cầu', 'bg-blue-100 text-blue-800'], APPROVE: ['Duyệt', 'bg-emerald-100 text-emerald-800'], REJECT: ['Từ chối', 'bg-amber-100 text-amber-800'], CANCEL: ['Hủy yêu cầu', 'bg-slate-200 text-slate-600'], DELETE: ['Xóa', 'bg-rose-100 text-rose-800'] };
  const dt = iso => new Date(iso).toLocaleString('vi-VN', { hour12: false, day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
  box.innerHTML = rows.length === 0 ? '<p class="text-xs text-slate-400 text-center py-3">Chưa có thao tác nào.</p>' : rows.map(l => {
    const [lb, cl] = ac[l.action] || [l.action, 'bg-slate-100'];
    return `<div class="p-3 rounded-xl border border-slate-200 text-xs space-y-1">
      <div class="flex justify-between gap-2"><span class="px-2 py-0.5 rounded font-bold ${cl}">${lb}</span><span class="text-[10px] text-slate-400">${dt(l.created_at)}</span></div>
      <div class="text-slate-800">${esc(l.detail || '')}</div>
      <div class="text-[10px] text-slate-500">Bởi: <b>${esc(l.actor_name || '')}</b> (${l.actor_role || ''})</div></div>`;
  }).join('');
}
state.transfers = [];
async function loadTransfers() {
  const { data, error } = await supabaseClient.from('sale_transfers').select('*').order('created_at', { ascending: false }).limit(500);
  state.transfersOk = !error;
  state.transfers = error ? [] : (data || []);
  const n = myTransfers().filter(t => t.status === 'PENDING').length;
  const el = document.getElementById('badge-transfer');
  if (el) { el.innerText = n; el.classList.toggle('hidden', n === 0); }
}
function myTransfers() {
  if (currentUser?.role !== 'SALE') return state.transfers;
  return state.transfers.filter(t => t.from_rep_id === currentUser.sales_rep_id || t.to_rep_id === currentUser.sales_rep_id);
}
function openTransferModal() {
  const isSale = currentUser.role === 'SALE';
  const opt = r => `<option value="${r.id}">${r.full_name}</option>`;
  const me = state.salesReps.find(r => r.id === currentUser.sales_rep_id) || { id: currentUser.sales_rep_id, full_name: currentUser.display_name };
  const fromSel = document.getElementById('trFrom');
  fromSel.innerHTML = isSale ? opt(me) : state.salesReps.map(opt).join('');
  fromSel.disabled = isSale;
  refreshTrTo();
  document.getElementById('trGroup').innerHTML = state.productGroups.map(g => `<option value="${g.id}">[${g.tier || 'Premium'}] ${g.group_name}</option>`).join('');
  document.getElementById('trMonth').innerHTML = state.availableMonths.map(m => `<option value="${m}">Tháng ${m.slice(5, 7)}/${m.slice(0, 4)}</option>`).join('');
  document.getElementById('trQty').value = ''; document.getElementById('trReason').value = '';
  const msg = document.getElementById('trMsg');
  if (!state.transfersOk) { msg.innerText = 'Chưa có bảng sale_transfers trong Supabase. Chạy file setup_supabase.sql trước.'; msg.classList.remove('hidden'); }
  else msg.classList.add('hidden');
  renderTransferList();
  document.getElementById('transferModal').classList.remove('hidden');
}
async function submitTransfer(e) {
  e.preventDefault();
  const v = id => document.getElementById(id).value;
  const msg = document.getElementById('trMsg');
  const fail = t => { msg.innerText = t; msg.classList.remove('hidden'); };
  msg.classList.add('hidden');
  const q = Number(v('trQty')), reason = v('trReason').trim();
  if (!v('trFrom') || !v('trTo') || v('trFrom') === v('trTo')) return fail('Chọn 2 sale khác nhau!');
  if (!(q > 0)) return fail('Số lượng phải lớn hơn 0!');
  if (!reason) return fail('Vui lòng nhập lý do!');
  const { error } = await supabaseClient.from('sale_transfers').insert({
    month_date: v('trMonth'), from_rep_id: v('trFrom'), to_rep_id: v('trTo'), product_group_id: v('trGroup'),
    quantity: q, reason, status: 'PENDING', requested_by: currentUser.id, requested_by_name: currentUser.display_name
  });
  if (error) return fail('Lỗi gửi yêu cầu: ' + error.message);
  await logTransfer('CREATE', { from_rep_id: v('trFrom'), to_rep_id: v('trTo'), product_group_id: v('trGroup'), quantity: q, month_date: v('trMonth'), reason });
  document.getElementById('trQty').value = ''; document.getElementById('trReason').value = '';
  await loadTransfers(); renderTransferList();
}
async function updateTransfer(id, patch, extra) {
  let q = supabaseClient.from('sale_transfers').update(patch).eq('id', id).eq('status', 'PENDING');
  if (extra) q = q.eq('requested_by', currentUser.id);
  const { error } = await q;
  if (error) return alert('Lỗi: ' + error.message);
  const t0 = state.transfers.find(x => x.id === id);
  if (t0) await logTransfer({ APPROVED: 'APPROVE', REJECTED: 'REJECT', CANCELLED: 'CANCEL' }[patch.status], t0, patch.decision_note);
  await loadTransfers(); renderTransferList(); renderActiveTab();
}
function decideTransfer(id, status) {
  if (!isManagerRole()) return;
  let note = null;
  if (status === 'REJECTED') { note = prompt('Lý do từ chối:'); if (note === null) return; }
  else if (!confirm('Duyệt luân chuyển này? Số liệu đối chiếu của 2 sale sẽ thay đổi.')) return;
  updateTransfer(id, { status, decided_by_name: currentUser.display_name, decided_at: new Date().toISOString(), decision_note: note || null });
}
function cancelTransfer(id) {
  if (confirm('Hủy yêu cầu này?')) updateTransfer(id, { status: 'CANCELLED', decided_at: new Date().toISOString() }, true);
}
function renderTransferList() {
  const rep = new Map(state.salesReps.map(r => [r.id, r.full_name])), grp = new Map(state.productGroups.map(g => [g.id, g.group_name]));
  const st = { PENDING: ['Chờ duyệt', 'bg-amber-100 text-amber-800'], APPROVED: ['Đã duyệt', 'bg-emerald-100 text-emerald-800'], REJECTED: ['Từ chối', 'bg-rose-100 text-rose-800'], CANCELLED: ['Đã hủy', 'bg-slate-200 text-slate-600'] };
  const dt = iso => iso ? new Date(iso).toLocaleString('vi-VN', { hour12: false, day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' }) : '';
  const list = myTransfers();
  document.getElementById('transferList').innerHTML = list.length === 0 ? '<p class="text-xs text-slate-400 text-center py-3">Chưa có yêu cầu luân chuyển nào.</p>' : list.map(t => {
    const [lb, cl] = st[t.status] || [t.status, 'bg-slate-100'];
    return `<div class="p-3 rounded-xl border border-slate-200 text-xs space-y-1">
      <div class="flex justify-between gap-2"><b class="text-slate-900">${rep.get(t.from_rep_id) || '?'} &rarr; ${rep.get(t.to_rep_id) || '?'}</b><span class="px-2 py-0.5 rounded font-bold ${cl}">${lb}</span></div>
      <div class="text-slate-700">${grp.get(t.product_group_id) || ''} • <b>${fmtNum(t.quantity)}</b> • Tháng ${String(t.month_date).slice(5, 7)}/${String(t.month_date).slice(0, 4)}</div>
      <div class="text-slate-500">Lý do: ${esc(t.reason || '')}</div>
      <div class="text-[10px] text-slate-400">Gửi: ${esc(t.requested_by_name || '')} lúc ${dt(t.created_at)}${t.decided_at ? ` • ${lb}: ${esc(t.decided_by_name || '')} lúc ${dt(t.decided_at)}` : ''}${t.decision_note ? ` • ${esc(t.decision_note)}` : ''}</div>
      ${isManagerRole() ? `<button onclick="deleteTransfer('${t.id}')" class="text-[11px] text-rose-600 font-bold hover:underline">Xóa yêu cầu</button>` : ''}
      ${t.status === 'PENDING' ? `<div class="flex gap-2 pt-1">
        ${isManagerRole() ? `<button onclick="decideTransfer('${t.id}','APPROVED')" class="flex-1 bg-emerald-700 text-white font-bold py-1.5 rounded-lg">Duyệt</button><button onclick="decideTransfer('${t.id}','REJECTED')" class="flex-1 bg-white border border-rose-200 text-rose-600 font-bold py-1.5 rounded-lg">Từ chối</button>` : ''}
        ${t.requested_by === currentUser.id ? `<button onclick="cancelTransfer('${t.id}')" class="flex-1 bg-white border border-slate-300 text-slate-600 font-bold py-1.5 rounded-lg">Hủy yêu cầu</button>` : ''}</div>` : ''}
    </div>`;
  }).join('');
}
// Tổng luân chuyển đã duyệt của sale đang chọn trong các tháng đã chọn (theo hạng SP nếu có lọc)
function getTransferNet(tierFilter) {
  const rep = getActiveSalesRepId();
  if (!rep || rep === 'ALL') return 0;
  const sel = new Set(selectedMonths);
  let net = 0;
  state.transfers.filter(t => t.status === 'APPROVED' && sel.has(String(t.month_date).slice(0, 10))).forEach(t => {
    const g = state.productGroups.find(x => x.id === t.product_group_id);
    if (!g) return;
    const tier = g.tier || (g.brand.toLowerCase().includes('huda') ? 'Mainstream' : 'Premium');
    if (tierFilter && tierFilter !== 'ALL' && tier !== tierFilter) return;
    net += t.from_rep_id === rep ? -Number(t.quantity) : t.to_rep_id === rep ? Number(t.quantity) : 0;
  });
  return net;
}
function fmtNum(n) { return Number(n || 0).toLocaleString('vi-VN'); }
function toggleAccordion(id) { document.getElementById(id).classList.toggle('hidden'); }
