# Yamada_chiu Wrapper

Project này được tách từ wrapper của `Yamada_Reg`, giữ phần xung quanh để chạy nhiều máy:

- UI Tkinter tối giản: `gui.py`
- batch runner đa device: `scripts/chiu_batch_flow.py`
- full-flow skeleton: `scripts/chiu_full_flow.py`
- Crane container manager: `scripts/crane_container_manager.py`
- Frida DOM runner/agent skeleton: `scripts/chiu_dom_runner.py`, `agents/chiu_flow_agent.js`
- Excel lock/status/container helpers

Flow DOM đã gắn: login (changephone/chgauth) + gold + onepiece, và **đăng ký mới** (reg001 → reg006) chạy tự động tuỳ theo từng nick. Khi có HTML/màn hình mới, thêm logic vào `agents/chiu_flow_agent.js` và `scripts/chiu_full_flow.py`.

## Chạy UI

```bash
python3 /Users/macbook/Desktop/FPT/Yamada_chiu/gui.py
```

## Excel

Sheet chính là `Accounts`.

Các cột giữ lại:

`email`, `password`, `crane_container_id`, `crane_container_name`, `crane_status`, `crane_assigned_at`, `crane_last_used_at`, `frida_device_id`, `frida_device_name`, `reg_status`, `gold_status`, `chiu_status`, `status`, `error_details`, `notes`

### Đăng ký vs đăng nhập tuỳ theo nick (`reg_status`)

Cột `reg_status` quyết định mỗi nick sẽ **đăng ký mới** hay chỉ **đăng nhập**:

- `reg_status` trống hoặc khác `SUCCESS` → agent chạy luồng đăng ký (reg001 → reg006) trước, rồi tiếp tục login/gold/onepiece trong cùng lần chạy. Sau khi reg006 hoàn tất, `chiu_full_flow.py` ghi `reg_status = SUCCESS`.
- `reg_status = SUCCESS` → bỏ qua đăng ký, chỉ đăng nhập.

Việc nhận diện màn đăng ký dùng matcher chặt (đủ selector bắt buộc + url/title/body) và **chỉ bật khi `reg_status != SUCCESS`**, nên không bao giờ nhầm với màn login (changephone/chgauth) hay màn home/gold/onepiece đã đăng nhập.

### Cột cần điền cho nick đăng ký mới

Khi một nick cần đăng ký (`reg_status` để trống), điền thêm các cột đăng ký — tên cột chấp nhận alias (xem `COLUMN_ALIASES` trong `src/connections/xlsx_connection.py`):

`pin`, `phone` (tel), `last_name` (sei), `first_name` (mei), `last_name_kana` (seikana), `first_name_kana` (meikana), `postal_code` (zip), `prefecture` (prefcode), `city` (adrs1), `address_rest` (address/adrs2), `dob` (birthday), `gender` (sex)

Nick chỉ đăng nhập (`reg_status = SUCCESS`) không cần các cột này.

## Checkbox "Luồng mới" trên UI

Trên UI có một checkbox bật/tắt **toàn bộ luồng mới**:

- **Tick** → chạy luồng mới cho mỗi nick:
  1. Bật luồng **đăng ký** (reg001→reg006) tuỳ theo `reg_status` (xem mục trên) — nick `reg_status != SUCCESS` sẽ đăng ký rồi mới tiếp tục; `reg_status = SUCCESS` thì chỉ đăng nhập.
  2. Tạo một container Crane **mới** mỗi nick (bỏ qua container cũ trên row).
  3. Ghi `containerID` + `deviceID` ra Excel (`crane_container_id`, `crane_container_name`, `frida_device_id`, `frida_device_name`).
- **Bỏ tick** → giữ nguyên **luồng cũ** y như trước: KHÔNG đăng ký (kể cả khi `reg_status` trống), chỉ login/gold/onepiece, reuse container active như bình thường.

CLI tương đương: `scripts/chiu_batch_flow.py ... --new-container`, truyền tiếp `--enable-register` (bật luồng đăng ký trong DOM) và `--container-mode create` (tạo container mới) xuống từng nick.

## Thẻ sandbox theo device (cards.json)

Thẻ thanh toán Gold **không còn lấy từ Excel** nữa mà nạp từ file `cards.json` ở gốc repo (đổi đường dẫn bằng env `YAMADA_CARDS_FILE`). Đây là thẻ test sandbox.

- Định dạng: danh sách object, mỗi thẻ 3 trường — xem `cards.example.json`:
  ```json
  [ { "credit_card_number": "...", "credit_card_exp": "MM/YY", "credit_card_cvv": "..." } ]
  ```
- Khi batch chạy nhiều device, `chiu_batch_flow.py` truyền danh sách device xuống từng worker. Mỗi device lấy cố định 1 thẻ chính theo thứ tự device trong batch. Ví dụ 10 device + 16 thẻ: 10 thẻ đầu là thẻ chính cho 10 máy, 6 thẻ sau là pool fallback.
- Nếu HTML báo thẻ Gold bị từ chối/khoá, `chiu_full_flow.py` đổi sang 1 thẻ trong pool fallback và retry đúng 1 lần.
- Khi chạy lẻ không có danh sách device, script vẫn fallback theo số dòng Excel để không vỡ flow cũ.
- Thẻ được chọn **ghi đè** cột `credit_card_*` trong Excel (nếu còn). Nếu `cards.json` trống/không có → rơi về cột Excel như cũ.

Logic ở `scripts/card_rotation.py`, được chèn vào profile tại `scripts/chiu_profile_from_excel.py` và nhánh rewrite OTP của `scripts/chiu_full_flow.py`; agent vẫn đọc `credit_card_number/exp/cvv` từ profile như trước.

## Crane

Bundle mặc định vẫn là Yamada app:

`jp.co.unisys.yamadamobile`

Có thể đổi bằng env:

```bash
YAMADA_APP_ID=<bundle_id> python3 scripts/crane_container_manager.py info
```
