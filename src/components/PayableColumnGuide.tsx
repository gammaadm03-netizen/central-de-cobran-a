export default function PayableColumnGuide() {
  return <details className="import-format-help"><summary>Como as colunas de Contas a Pagar são utilizadas</summary>
    <dl>
      <dt>Lançamento + Filial</dt><dd>Identificam o título nas próximas importações. No relatório completo de abertos, alterações de valor ou vencimento atualizam o mesmo lançamento.</dd>
      <dt>Histórico</dt><dd>Descrição da conta a pagar e da parcela.</dd>
      <dt>Plano cp - Conta: nome</dt><dd>Centro de custo da origem, vinculado ao Centro de Custo Macro. As classificações existentes são reaproveitadas; planos novos ficam como NÃO CLASSIFICADO para ajuste posterior.</dd>
      <dt>Plano cc - Conta: nome</dt><dd>Banco previsto no relatório. A informação fica preservada; um pagamento financeiro registrado separadamente permite escolher o banco efetivo dos títulos comuns.</dd>
      <dt>Emissão: valor do lançamento</dt><dd>Valor provisionado. O relatório completo de abertos atualiza o valor dos títulos. O arquivo de baixados altera somente o status.</dd>
      <dt>Emissão: data</dt><dd>Data de emissão do título.</dd>
      <dt>Vencimento: data</dt><dd>Vencimento atualizado pelo relatório completo de abertos mais recente.</dd>
      <dt>Cheque: número</dt><dd>Número do cheque, separado do lançamento. No registro financeiro de um título com cheque, o banco de pagamento segue a regra BRADESCO F2G.</dd>
    </dl><p className="help-text">Pagamentos já registrados permanecem no histórico. Somente o relatório completo de abertos baixa títulos ausentes; o relatório de baixados atua nos títulos listados. O status Pago por relatório não cria pagamento financeiro. Um título que reapareça no relatório completo volta à previsão.</p>
  </details>;
}
