/** PayChangu expects Malawi local format e.g. 0999123456 */
export function normalizeMalawiPhone(phone) {
    const digits = phone.replace(/\D/g, "");
    if (digits.length < 9)
        return null;
    if (digits.startsWith("265"))
        return `0${digits.slice(3)}`;
    if (digits.startsWith("0"))
        return digits;
    return `0${digits}`;
}
export function maskPhone(phone) {
    const n = normalizeMalawiPhone(phone) ?? phone;
    if (n.length < 6)
        return "••••";
    return `${n.slice(0, 3)}•••${n.slice(-3)}`;
}
