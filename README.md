# Yamada_chiu Wrapper

Project này được tách từ wrapper của `Yamada_Reg`, giữ phần xung quanh để chạy nhiều máy:

- UI Tkinter tối giản: `gui.py`
- batch runner đa device: `scripts/chiu_batch_flow.py`
- full-flow skeleton: `scripts/chiu_full_flow.py`
- Crane container manager: `scripts/crane_container_manager.py`
- Frida DOM runner/agent skeleton: `scripts/chiu_dom_runner.py`, `agents/chiu_flow_agent.js`
- Excel lock/status/container helpers

Flow DOM thật chưa được gắn. Khi có HTML/màn hình mới, thêm logic vào `agents/chiu_flow_agent.js` và `scripts/chiu_full_flow.py`.

## Chạy UI

```bash
python3 /Users/macbook/Desktop/FPT/Yamada_chiu/gui.py
```

## Excel

Sheet chính là `Accounts`.

Các cột giữ lại:

`email`, `password`, `crane_container_id`, `crane_container_name`, `crane_status`, `crane_assigned_at`, `crane_last_used_at`, `frida_device_id`, `frida_device_name`, `status`, `error_details`, `notes`

Các cột đăng ký cũ như `pin`, `phone`, tên, kana, địa chỉ, ngày sinh, giới tính đã bỏ khỏi template.

## Crane

Bundle mặc định vẫn là Yamada app:

`jp.co.unisys.yamadamobile`

Có thể đổi bằng env:

```bash
YAMADA_APP_ID=<bundle_id> python3 scripts/crane_container_manager.py info
```
