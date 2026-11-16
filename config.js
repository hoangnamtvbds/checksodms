// ===== CẤU HÌNH ĐỐI CHIẾU SALE • TEAM BC =====
const SUPABASE_URL = "https://incbokfnoabjhvbwxkli.supabase.co";
const SUPABASE_ANON_KEY = "sb_publishable_VQwy6zq_YDNeGPYf5cOJng_Flt2WUk-";

// Mã NPP (DisCode) cần lấy bên DMS
const DIS_CODE = 'CD1084';

// Chỉ nhận dòng Kiot có nhóm hàng/tên hàng chứa một trong các từ khóa này
const CARLSBERG_KEYWORDS = ['carlsberg', 'tuborg', 'blanc', 'huda', 'somersby'];

// Bỏ qua dòng Kiot nếu nhóm hàng/tên hàng chứa từ này, hoặc ĐVT nằm trong danh sách
const KV_SKIP_NAME_PARTS = ['posm', 'huda dù'];
const KV_SKIP_UNITS = ['cái'];

// Mã SKU không cần phân nhóm (POSM, quà tặng...)
const IGNORED_SKU_PREFIX = 'DMS_POSM';
const IGNORED_SKU_CODES = ['8001555', '10379'];

// Giới hạn dung lượng Supabase (gói free) để hiện vòng tròn dung lượng
const DB_LIMIT_MB = 500;
const EST_BYTES_PER_ROW = 450;
