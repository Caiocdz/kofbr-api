/** Tema salvo (ou o do sistema), aplicado no <head> antes de desenhar a página. Módulo comum (não "use client"),
    para o layout do servidor poder embutir o texto do script. */
export const THEME_KEY = "gargalo-tema";
export const THEME_BOOT = `try{var t=localStorage.getItem('${THEME_KEY}');if(t!=='light'&&t!=='dark'){t=matchMedia('(prefers-color-scheme: dark)').matches?'dark':'light'}document.documentElement.dataset.theme=t}catch(e){}`;
