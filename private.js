let emeraldAccessCode = '';

function generateAccessCode(length = 128) {
  const chars = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  let token = '';
  for (let i = 0; i < length; i++) {
    token += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return token;
}

function updateAccessCode() {
  emeraldAccessCode = generateAccessCode();
  sessionStorage.setItem('emerald_access_code', emeraldAccessCode);
}

// Initial code setup and auto-refresh every 30s
updateAccessCode();
setInterval(updateAccessCode, 5000);

document.getElementById('redirect-form').addEventListener('submit', function(e) {
  e.preventDefault();
  const password = document.getElementById('code-input').value;
  const passwordInput = document.getElementById('code-input');

  if (password === 'Ice@autodispenser') {
  const currentCode = sessionStorage.getItem('emerald_access_code');
  window.location.href = `/autodispenser.html?code=${currentCode}`;
  } else if (password === 'Ice@us') {
      const currentCode = sessionStorage.getItem('emerald_access_code');
      window.location.href = `/asaj.html?code=${currentCode}`;
  } else {
    passwordInput.classList.add('error-input', 'shake');
    setTimeout(() => {
      passwordInput.classList.remove('shake');
      passwordInput.classList.remove('error-input');
    }, 1000);
  }
});