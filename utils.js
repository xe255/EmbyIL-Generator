function generateRandomString(length) {
    const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
    let result = '';
    for (let i = 0; i < length; i++) {
        result += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return result;
}

function generateUsername5() {
    return generateRandomString(5);
}

function generateNumericString(length) {
    const digits = '0123456789';
    let result = '';
    for (let i = 0; i < length; i++) {
        result += digits.charAt(Math.floor(Math.random() * digits.length));
    }
    return result;
}

function generateStrongPassword() {
    const upper = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
    const lower = 'abcdefghijklmnopqrstuvwxyz';
    const digits = '0123456789';
    const special = '!@#$%^&*()_+~`|}{[]:;?><,./-=';

    const all = upper + lower + digits + special;

    let password = '';
    password += upper.charAt(Math.floor(Math.random() * upper.length));
    password += lower.charAt(Math.floor(Math.random() * lower.length));
    password += digits.charAt(Math.floor(Math.random() * digits.length));
    password += special.charAt(Math.floor(Math.random() * special.length));

    for (let i = 0; i < 8; i++) {
        password += all.charAt(Math.floor(Math.random() * all.length));
    }

    // Shuffle password
    return password.split('').sort(() => 0.5 - Math.random()).join('');
}

module.exports = {
    generateRandomString,
    generateUsername5,
    generateNumericString,
    generateStrongPassword
};
